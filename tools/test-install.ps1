[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
if ($env:RELAYBRIDGE_SKIP_INSTALL_TEST -eq '1') {
  Write-Host '[RelayBridge] Nested install test skipped.' -ForegroundColor DarkGray
  exit 0
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$installer = Join-Path $repoRoot 'install.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('relaybridge-install-test-' + [Guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $testRoot 'RelayBridge'
$startedPort = 0
$legacyPort = 0
$legacyProcess = $null
$emDash = [string][char]0x2014

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Get-TreeFingerprint([string]$Root) {
  $lines = @()
  Get-ChildItem -LiteralPath $Root -File -Recurse -Force | Where-Object { $_.Extension -ine '.log' } | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($Root.Length).TrimStart('\', '/')
    $lines += ($relative + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($lines -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-FreePort {
  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { return ([Net.IPEndPoint]$listener.LocalEndpoint).Port }
  finally { $listener.Stop() }
}

function Invoke-TestInstall([string]$FailAt = '', [switch]$Start, [int]$Port = 0) {
  if (-not $Port) { $Port = Get-FreePort }
  $previousFailAt = $env:RELAYBRIDGE_INSTALL_TEST_FAIL_AT
  try {
    $env:RELAYBRIDGE_INSTALL_TEST_FAIL_AT = $FailAt
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer,
      '-SourceDir', $repoRoot, '-InstallDir', $installRoot, '-SkipProviderSetup', '-NoBrowser', '-Port', [string]$Port)
    if (-not $Start) { $arguments += '-NoStart' }
    # Do not pipe or redirect the child PowerShell output. On Windows a
    # detached candidate server can inherit the pipeline/file handle, keeping
    # the test blocked even after install.ps1 itself has exited. Waiting on the
    # direct process handle still gives us the installer's real exit code.
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $proc.WaitForExit()
    $exitCode = [int]$proc.ExitCode
    $proc.Dispose()
    return [pscustomobject]@{ ExitCode = $exitCode; Port = $Port }
  } finally {
    $env:RELAYBRIDGE_INSTALL_TEST_FAIL_AT = $previousFailAt
  }
}

New-Item -ItemType Directory -Path (Join-Path $installRoot 'data\receipts'), (Join-Path $installRoot 'config') -Force | Out-Null
try {
  $legacyServer = @'
'use strict';
const fs = require('fs');
const http = require('http');
const token = fs.readFileSync('.bridge-token', 'utf8').trim();
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ version: '2.0.0', capabilityAuth: true }));
  }
  if (req.method === 'POST' && req.url === '/api/admin/shutdown' && req.headers['x-relaybridge-token'] === token) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}', () => server.close(() => process.exit(0)));
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, '127.0.0.1');
'@
  [IO.File]::WriteAllText((Join-Path $installRoot 'server.js'), ($legacyServer + "`n"), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $installRoot 'stale-code.js'), "must disappear after promotion`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $installRoot '.bridge-token'), (('a' * 64) + "`n"), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $installRoot '.state.json'), "{`"fullPermissions`":false}`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $installRoot 'data\receipts\preserved.jsonl'), "{`"receiptId`":`"old`"}`n", [Text.UTF8Encoding]::new($false))

  $operatorConfig = [ordered]@{
    _comment = "operator-owned config $emDash UTF-8 survives every merge"
    cursor = [ordered]@{
      label = 'Cursor Operator Seat'
      tags = @('custom-routing')
      autoRoute = $false
      model = 'operator-pinned-model'
      # Reproduce the briefly-installed PR #40 draft: the old shipped pins and
      # the release-added lock coexisted, so a later upgrade mistook the lock
      # for an operator override.
      model_tiers_locked = $true
      model_tiers = [ordered]@{
        light = [ordered]@{ args = @('--model', 'gpt-5.6-luna-low'); model = 'gpt-5.6-luna-low' }
        standard = [ordered]@{ args = @('--model', 'gpt-5.6-terra-medium'); model = 'gpt-5.6-terra-medium' }
        heavy = [ordered]@{ args = @('--model', 'gpt-5.6-sol-high'); model = 'gpt-5.6-sol-high' }
      }
    }
    claude = [ordered]@{
      model_tiers_locked = $true
      model_tiers = [ordered]@{
        standard = [ordered]@{ args = @('--model', 'operator-custom-model'); model = 'operator-custom-model' }
      }
    }
    custom_provider = [ordered]@{
      label = 'Private Operator Provider'
      tags = @('custom-routing')
      autoRoute = $false
      safe = @('private-provider')
      dangerous = @('private-provider')
    }
  }
  [IO.File]::WriteAllText((Join-Path $installRoot 'cli-config.json'), (($operatorConfig | ConvertTo-Json -Depth 20) + "`n"), [Text.UTF8Encoding]::new($false))
  $operatorRouting = [ordered]@{ taskPriorities = [ordered]@{ general = @('custom_provider') }; operatorNote = 'preserve me' }
  [IO.File]::WriteAllText((Join-Path $installRoot 'config\routing-policy.json'), (($operatorRouting | ConvertTo-Json -Depth 20) + "`n"), [Text.UTF8Encoding]::new($false))

  $before = Get-TreeFingerprint $installRoot
  $renameFailed = Invoke-TestInstall 'after-old-rename'
  Assert-True ($renameFailed.ExitCode -ne 0) 'the injected post-rename failure must fail the installer'
  Assert-True ((Get-TreeFingerprint $installRoot) -eq $before) 'rollback must restore the old root when candidate promotion never completes'

  $legacyPort = Get-FreePort
  $previousPort = $env:PORT
  try {
    $env:PORT = [string]$legacyPort
    $legacyProcess = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'server.js' -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru
  } finally { $env:PORT = $previousPort }
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    try {
      $legacyHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$legacyPort/api/health" -TimeoutSec 1 -UseBasicParsing
      break
    } catch { Start-Sleep -Milliseconds 100 }
  }
  Assert-True ($legacyHealth.version -eq '2.0.0') 'legacy fixture must be healthy before cutover'

  $failed = Invoke-TestInstall 'after-promote' -Port $legacyPort
  Assert-True ($failed.ExitCode -ne 0) 'the injected post-promotion failure must fail the installer'
  Assert-True ((Get-TreeFingerprint $installRoot) -eq $before) 'automatic rollback must restore retained release/runtime files byte-for-byte'
  $restoredHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$legacyPort/api/health" -TimeoutSec 3 -UseBasicParsing
  Assert-True ($restoredHealth.version -eq '2.0.0') 'rollback must restart a pre-buildId RelayBridge by its legacy version'
  $legacyToken = (Get-Content -LiteralPath (Join-Path $installRoot '.bridge-token') -Raw).Trim()
  Invoke-RestMethod -Uri "http://127.0.0.1:$legacyPort/api/admin/shutdown" -Method Post -Headers @{ 'X-RelayBridge-Token' = $legacyToken } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 -UseBasicParsing | Out-Null
  for ($attempt = 0; $attempt -lt 50 -and (Get-NetTCPConnection -State Listen -LocalPort $legacyPort -ErrorAction SilentlyContinue); $attempt++) { Start-Sleep -Milliseconds 100 }
  Assert-True (-not (Get-NetTCPConnection -State Listen -LocalPort $legacyPort -ErrorAction SilentlyContinue)) 'restored legacy bridge must shut down cleanly after rollback verification'
  $legacyPort = 0

  $success = Invoke-TestInstall -Start
  if ($success.ExitCode -ne 0) { throw "Installer success case failed with exit code $($success.ExitCode)." }
  $startedPort = $success.Port
  Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'server.js') -PathType Leaf) 'new server.js must be promoted'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $installRoot 'stale-code.js'))) 'stale release files must not survive promotion'
  Assert-True ((Get-Content -LiteralPath (Join-Path $installRoot '.bridge-token') -Raw).Trim() -eq ('a' * 64)) 'capability token bytes must be preserved'
  Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'data\receipts\preserved.jsonl')) 'retained data must be preserved'

  $merged = [IO.File]::ReadAllText((Join-Path $installRoot 'cli-config.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  Assert-True ($merged._comment -eq "operator-owned config $emDash UTF-8 survives every merge") 'operator UTF-8 text must survive config merge byte-exactly'
  $mergedBytes = [IO.File]::ReadAllBytes((Join-Path $installRoot 'cli-config.json'))
  Assert-True (([BitConverter]::ToString($mergedBytes)) -match 'E2-80-94') 'merged JSON must contain the exact UTF-8 em-dash byte sequence'
  Assert-True ($merged.cursor.model -eq 'operator-pinned-model') 'operator model pin must win over release defaults'
  Assert-True ($null -eq $merged.cursor.PSObject.Properties['model_tiers']) 'an upgrade to Cursor Auto-only must remove inherited stale named-model tiers'
  Assert-True ($null -eq $merged.cursor.PSObject.Properties['model_tiers_locked']) 'the draft-added lock must not survive as a fake operator override'
  Assert-True ($merged.cursor.model_tiers_mode -eq 'account_default') 'the release must record why Cursor has no named-model tiers'
  Assert-True ($merged.claude.model_tiers.standard.model -eq 'operator-custom-model') 'a genuinely custom locked operator tier must still be preserved'
  Assert-True ($merged.cursor.tags[0] -eq 'custom-routing') 'operator routing tags must be preserved'
  Assert-True ($merged.cursor.probe_expect -eq 'Logged in as') 'missing release fields must be added to existing providers'
  Assert-True ($null -ne $merged.copilot) 'new release providers must be added'
  Assert-True ($merged.custom_provider.label -eq 'Private Operator Provider') 'unknown operator providers must be preserved'
  $routing = [IO.File]::ReadAllText((Join-Path $installRoot 'config\routing-policy.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  Assert-True ($routing.operatorNote -eq 'preserve me') 'operator routing-policy fields must be preserved'
  Assert-True ($routing.taskPriorities.general[0] -eq 'custom_provider') 'operator routing priority must win'

  $build = [IO.File]::ReadAllText((Join-Path $installRoot 'build-info.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  Assert-True ([string]$build.buildId -match '^2\.0\.1\+[a-f0-9]{16}$') 'installed release must have an exact code-hash build identity'
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($success.Port)/api/health" -TimeoutSec 3 -UseBasicParsing
  Assert-True ([string]$health.buildId -eq [string]$build.buildId) 'promoted server health must report the exact staged build identity'
  $token = (Get-Content -LiteralPath (Join-Path $installRoot '.bridge-token') -Raw).Trim()
  Invoke-RestMethod -Uri "http://127.0.0.1:$($success.Port)/api/admin/shutdown" -Method Post -Headers @{ 'X-RelayBridge-Token' = $token } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 -UseBasicParsing | Out-Null
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$($success.Port)/api/health" -TimeoutSec 1 -UseBasicParsing | Out-Null }
    catch { break }
    Start-Sleep -Milliseconds 100
  }
  $startedPort = 0
  Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'node_modules\express') -PathType Container) 'locked dependencies must be staged before promotion'
  Assert-True ((Get-ChildItem -LiteralPath $testRoot -Directory | Where-Object { $_.Name -match '\.(stage|rollback|failed)\.' }).Count -eq 0) 'temporary release directories must be cleaned'

  Write-Host '[RelayBridge] Transactional install/rollback preservation test passed.' -ForegroundColor Green
} finally {
  if ($legacyPort -and (Test-Path -LiteralPath (Join-Path $installRoot '.bridge-token') -PathType Leaf)) {
    try {
      $legacyToken = (Get-Content -LiteralPath (Join-Path $installRoot '.bridge-token') -Raw).Trim()
      Invoke-RestMethod -Uri "http://127.0.0.1:$legacyPort/api/admin/shutdown" -Method Post -Headers @{ 'X-RelayBridge-Token' = $legacyToken } -ContentType 'application/json' -Body '{}' -TimeoutSec 2 -UseBasicParsing | Out-Null
    } catch {}
  }
  if ($legacyProcess -and -not $legacyProcess.HasExited) { Stop-Process -Id $legacyProcess.Id -Force -ErrorAction SilentlyContinue }
  if ($startedPort -and (Test-Path -LiteralPath (Join-Path $installRoot '.bridge-token') -PathType Leaf)) {
    try {
      $cleanupToken = (Get-Content -LiteralPath (Join-Path $installRoot '.bridge-token') -Raw).Trim()
      Invoke-RestMethod -Uri "http://127.0.0.1:$startedPort/api/admin/shutdown" -Method Post -Headers @{ 'X-RelayBridge-Token' = $cleanupToken } -ContentType 'application/json' -Body '{}' -TimeoutSec 2 -UseBasicParsing | Out-Null
      Start-Sleep -Milliseconds 500
    } catch {}
  }
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTestRoot) -like 'relaybridge-install-test-*') {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

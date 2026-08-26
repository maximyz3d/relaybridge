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

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function Get-TreeFingerprint([string]$Root) {
  $lines = @()
  Get-ChildItem -LiteralPath $Root -File -Recurse -Force | Where-Object { $_.Extension -ine '.log' } | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($Root.Length).TrimStart('\', '/')
    $lines += ($relative + ':' + (Get-Sha256 $_.FullName))
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
      '-SourceDir', $repoRoot, '-InstallDir', $installRoot, '-SkipProviderSetup', '-SkipCliPathRegistration', '-NoBrowser', '-Port', [string]$Port)
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

# Issue #82: the shipped provider turn ceiling has to be correctable by an
# upgrade, because config preservation otherwise keeps the installed copy
# forever. The migration must be exactly as narrow as it claims: it may replace
# the retired shipped value and nothing else. The full install below proves the
# end-to-end path; these cases exercise the branches one install cannot reach
# at once, by loading the real functions straight out of install.ps1.
function Get-InstallerFunctionText([string[]]$Names) {
  # Dot-sourcing has to happen in the script scope, so hand the caller the text
  # rather than defining the functions inside this one and losing them on return.
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$null)
  $blocks = @()
  foreach ($name in $Names) {
    $found = $ast.FindAll({
      param($node)
      $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name
    }, $true)
    if ($found.Count -ne 1) { throw "install.ps1 must define exactly one $name function (found $($found.Count))." }
    $blocks += $found[0].Extent.Text
  }
  return ($blocks -join "`n")
}

function Test-BudgetMigration([string]$InstalledBudgetJson) {
  # $Merged is what the generic merge produces: the installed scalar wins, which
  # is precisely why the retired ceiling could never be corrected by a release.
  $defaults = @'
{
  "_config_merge": { "managed_supervisor_budget_fields": { "maxTurns": { "retired_values": [24] } } },
  "_supervisor": { "providerBudget": { "maxOutputTokens": 100000, "maxTurns": null } }
}
'@ | ConvertFrom-Json
  $installedJson = '{ "_supervisor": { "providerBudget": ' + $InstalledBudgetJson + ' } }'
  $existing = $installedJson | ConvertFrom-Json
  $merged = $installedJson | ConvertFrom-Json
  return (Restore-ShippedManagedSupervisorBudget $merged $defaults $existing)._supervisor.providerBudget
}

. ([scriptblock]::Create((Get-InstallerFunctionText @('Test-RetiredJsonNumber', 'Format-JsonScalar', 'Restore-ShippedManagedSupervisorBudget'))))

$retired = Test-BudgetMigration '{ "maxOutputTokens": 100000, "maxTurns": 24 }'
Assert-True ($null -eq $retired.maxTurns) 'the exact retired shipped turn ceiling must migrate to the release default'
Assert-True ($retired.maxOutputTokens -eq 100000) 'migrating one field must not disturb the other budget dimensions'
Assert-True (((@($retired.PSObject.Properties.Name)) -join ',') -eq 'maxOutputTokens,maxTurns') 'migrating a value must not reorder the operator file'

$override = Test-BudgetMigration '{ "maxTurns": 40 }'
Assert-True ($override.maxTurns -eq 40) 'an operator turn ceiling this release never shipped must be preserved'

$disabled = Test-BudgetMigration '{ "maxTurns": null }'
Assert-True ($null -eq $disabled.maxTurns) 'an operator who already disabled turns must stay disabled'

$adjacent = Test-BudgetMigration '{ "maxTurns": 25 }'
Assert-True ($adjacent.maxTurns -eq 25) 'a value one away from the retired default is an operator choice, not the retired default'

$stringly = Test-BudgetMigration '{ "maxTurns": "24" }'
Assert-True ($stringly.maxTurns -eq '24') 'a value this release never shipped must not be coerced into the retired number'

$absent = Test-BudgetMigration '{ "maxOutputTokens": 100000 }'
Assert-True ($null -eq $absent.PSObject.Properties['maxTurns']) 'a field the operator never set must not be invented by the migration'

Assert-True (Test-RetiredJsonNumber ([long]24) ([int]24)) 'JSON numeric widths must compare numerically'
Assert-True (-not (Test-RetiredJsonNumber $true ([int]1))) 'a boolean must never match a retired number'
Assert-True (-not (Test-RetiredJsonNumber '24' ([int]24))) 'a string must never match a retired number'
Assert-True (-not (Test-RetiredJsonNumber ([datetime]'2024-01-01') ([int]24))) 'a date-like string parsed by ConvertFrom-Json must be rejected, not cast'
Assert-True (Test-RetiredJsonNumber ([decimal]24) ([int]24)) 'a decimal literal must still match its retired integer'
Assert-True ((Format-JsonScalar $null) -eq 'null') 'the migration report must name the shipped null explicitly'
Write-Host '[RelayBridge] Managed supervisor budget migration cases passed.' -ForegroundColor DarkGray

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
    _supervisor = [ordered]@{
      providerBudget = [ordered]@{
        maxTurns = 24
      }
    }
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
      safe = @('claude', '--permission-mode', 'plan', '--model', 'operator-claude-model', '--effort', 'max', '--operator-flag')
      dangerous = @('claude', '--model', 'operator-claude-model', '--effort', 'max', '--dangerously-skip-permissions', '--operator-flag')
      oneshot_safe = @('claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'plan', '--model', 'operator-claude-model', '--effort', 'max', '--operator-flag')
      oneshot_dangerous = @('claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'operator-claude-model', '--effort', 'max', '--dangerously-skip-permissions', '--operator-flag')
      model_tiers_locked = $true
      model_tiers = [ordered]@{
        standard = [ordered]@{ args = @('--model', 'operator-custom-model'); model = 'operator-custom-model' }
      }
    }
    claude_fable = [ordered]@{
      safe = @('claude', '--permission-mode', 'plan', '--model', 'operator-fable-model', '--effort', 'max')
      dangerous = @('claude', '--model', 'operator-fable-model', '--effort', 'max', '--dangerously-skip-permissions')
      oneshot_safe = @('claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'plan', '--model', 'operator-fable-model', '--effort', 'max')
      oneshot_dangerous = @('claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'operator-fable-model', '--effort', 'max', '--dangerously-skip-permissions')
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
  Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'relaybridge.cmd') -PathType Leaf) 'Windows CLI shim must be promoted'
  $cliHelp = & (Join-Path $installRoot 'relaybridge.cmd') --help 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -eq 0) 'promoted Windows CLI shim must execute successfully'
  Assert-True ($cliHelp -match 'relaybridge status') 'promoted Windows CLI shim must invoke bin/relaybridge.js'

  $pathHelper = Join-Path $installRoot 'tools\register-cli-path.ps1'
  $firstPath = & $pathHelper -InstallDir $installRoot -NoPersist -UserPath 'C:\Windows' -ProcessPath 'C:\Windows\System32'
  Assert-True ($firstPath.UserPath -eq ('C:\Windows;' + $installRoot)) 'PATH helper must append a custom install root without replacing entries'
  Assert-True ($firstPath.ProcessPath -eq ('C:\Windows\System32;' + $installRoot)) 'PATH helper must expose the CLI to the current installer process'
  $secondPath = & $pathHelper -InstallDir $installRoot -NoPersist -UserPath $firstPath.UserPath -ProcessPath $firstPath.ProcessPath
  Assert-True (-not $secondPath.UserPathChanged -and -not $secondPath.ProcessPathChanged) 'PATH registration must be idempotent'
  Assert-True ((@($secondPath.UserPath -split ';' | Where-Object { $_ -eq $installRoot })).Count -eq 1) 'PATH registration must not duplicate the install root'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $installRoot 'stale-code.js'))) 'stale release files must not survive promotion'
  Assert-True ((Get-Content -LiteralPath (Join-Path $installRoot '.bridge-token') -Raw).Trim() -eq ('a' * 64)) 'capability token bytes must be preserved'
  Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'data\receipts\preserved.jsonl')) 'retained data must be preserved'

  $merged = [IO.File]::ReadAllText((Join-Path $installRoot 'cli-config.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  Assert-True ($merged._comment -eq "operator-owned config $emDash UTF-8 survives every merge") 'operator UTF-8 text must survive config merge byte-exactly'
  Assert-True ($null -eq $merged._supervisor.providerBudget.maxTurns) 'retired shipped maxTurns=24 must migrate to the release default instead of killing healthy terminal results'
  $mergedBytes = [IO.File]::ReadAllBytes((Join-Path $installRoot 'cli-config.json'))
  Assert-True (([BitConverter]::ToString($mergedBytes)) -match 'E2-80-94') 'merged JSON must contain the exact UTF-8 em-dash byte sequence'
  Assert-True ($merged.cursor.model -eq 'operator-pinned-model') 'operator model pin must win over release defaults'
  Assert-True ($null -eq $merged.cursor.PSObject.Properties['model_tiers']) 'an upgrade to Cursor Auto-only must remove inherited stale named-model tiers'
  Assert-True ($null -eq $merged.cursor.PSObject.Properties['model_tiers_locked']) 'the draft-added lock must not survive as a fake operator override'
  Assert-True ($merged.cursor.model_tiers_mode -eq 'account_default') 'the release must record why Cursor has no named-model tiers'
  Assert-True ($merged.claude.model_tiers.standard.model -eq 'operator-custom-model') 'a genuinely custom locked operator tier must still be preserved'
  foreach ($providerName in @('claude', 'claude_fable')) {
    foreach ($slotName in @('safe', 'dangerous', 'oneshot_safe', 'oneshot_dangerous')) {
      $slotArgs = @($merged.$providerName.$slotName)
      $effortIndex = [Array]::IndexOf($slotArgs, '--effort')
      Assert-True ($effortIndex -ge 0 -and $slotArgs[$effortIndex + 1] -eq 'high') "$providerName.$slotName must migrate legacy maximum effort to the shipped safe baseline"
    }
  }
  Assert-True ($merged.claude.safe[[Array]::IndexOf(@($merged.claude.safe), '--model') + 1] -eq 'operator-claude-model') 'managed-argument migration must preserve an operator model choice'
  Assert-True (@($merged.claude.safe) -contains '--operator-flag') 'managed-argument migration must preserve unrelated operator flags'
  Assert-True ($merged.claude_fable.safe[[Array]::IndexOf(@($merged.claude_fable.safe), '--model') + 1] -eq 'operator-fable-model') 'managed-argument migration must preserve the Fable model choice'
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

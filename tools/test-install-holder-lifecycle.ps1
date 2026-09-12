[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RepositoryRoot)
# Windows native acceptance cases. No provider CLI is used.
# Reuses functions and the exact fake legacy REST server from test-install.ps1.
$ErrorActionPreference = 'Stop'
$repoRoot = $RepositoryRoot
$installer = Join-Path $repoRoot 'install.ps1'
$harness = Join-Path $repoRoot 'tools\test-install.ps1'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('rb-holder-lifecycle-' + [guid]::NewGuid().ToString('N'))
$sourceAst = [System.Management.Automation.Language.Parser]::ParseFile($harness, [ref]$null, [ref]$null)
$wanted = @('Assert-True', 'Get-Sha256', 'Get-TreeFingerprint', 'Get-FreePort', 'Invoke-TestInstall')
$functions = @{}
foreach ($function in $sourceAst.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  if ($wanted -contains $function.Name) { $functions[$function.Name] = $function.Extent.Text }
}
foreach ($name in $wanted) { if (-not $functions.ContainsKey($name)) { throw "Existing native fixture helper missing: $name" } }
# Bound only this owned installer subprocess; keep all real installer behavior.
$functions['Invoke-TestInstall'] = $functions['Invoke-TestInstall'].Replace('$proc.WaitForExit()', 'if (-not $proc.WaitForExit(30000)) { $proc.Kill(); $proc.WaitForExit(); throw "owned fixture installer exceeded 30 seconds" }')
. ([scriptblock]::Create(($wanted | ForEach-Object { $functions[$_] }) -join "`n"))
$legacyAssignments = @($sourceAst.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
  $node.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
  $node.Left.VariablePath.UserPath -eq 'legacyServer'
}, $true))
Assert-True ($legacyAssignments.Count -eq 1) 'extract exactly one existing fake REST fixture'
$legacyLiterals = @($legacyAssignments[0].Right.FindAll({ param($node) $node -is [System.Management.Automation.Language.StringConstantExpressionAst] }, $true))
Assert-True ($legacyLiterals.Count -eq 1) 'legacy REST fixture is a literal, never execute source to extract it'
$legacyServer = $legacyLiterals[0].Value
function Write-Fixture([string]$File, [string]$Text) { [IO.File]::WriteAllText($File, ($Text + "`n"), [Text.UTF8Encoding]::new($false)) }
function Quote-Fixture([string]$Value) { if ($Value.Contains('"')) { throw 'invalid fixture path' }; return '"' + $Value + '"' }
function Wait-FixtureReady([string]$File) {
  for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $File); $attempt++) { Start-Sleep -Milliseconds 50 }
  Assert-True (Test-Path -LiteralPath $File) "test-owned helper reached ready: $File"
  return [IO.File]::ReadAllText($File) | ConvertFrom-Json
}
function Get-FixtureHealth([int]$FixturePort) {
  return Invoke-RestMethod -Uri "http://127.0.0.1:$FixturePort/api/health" -TimeoutSec 2 -UseBasicParsing
}
$helper = @'
'use strict';
const fs = require('node:fs');
const [ready, stop, nonce] = process.argv.slice(2);
fs.writeFileSync(ready, JSON.stringify({ pid: process.pid, cwd: process.cwd(), nonce }));
const timer = setInterval(() => {
  try { if (fs.readFileSync(stop, 'utf8').trim() === nonce) process.exit(0); } catch {}
}, 50);
setTimeout(() => process.exit(91), 90000);
'@
$hook = @'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture-settings.json'), 'utf8'));
(async () => {
  const phase = process.argv[2];
  fs.writeFileSync(path.join(cfg.markers, phase + '.entered'), 'entered\n');
  if (phase !== 'tests' || cfg.mode !== 'staging') return;
  const child = spawn(process.execPath, [cfg.holderScript, cfg.ready, cfg.stop, cfg.nonce], {
    cwd: cfg.installRoot, detached: true, windowsHide: true, stdio: 'ignore'
  });
  child.unref();
  child.on('error', error => { throw error; });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(cfg.ready)) {
    if (Date.now() >= deadline) throw new Error('owned staged holder failed readiness');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const ready = JSON.parse(fs.readFileSync(cfg.ready, 'utf8'));
  if (ready.pid !== child.pid || ready.nonce !== cfg.nonce || ready.cwd.toLowerCase() !== cfg.installRoot.toLowerCase()) throw new Error('owned holder identity mismatch');
  fs.writeFileSync(path.join(cfg.markers, 'tests.completed'), JSON.stringify({ holderPid: child.pid }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
'@
$controls = New-Object 'System.Collections.Generic.List[object]'
$processes = New-Object 'System.Collections.Generic.List[object]'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$oldPort = $env:PORT
try {
  New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
  foreach ($mode in @('early', 'staging')) {
    $caseRoot = Join-Path $testRoot $mode
    $installRoot = Join-Path $caseRoot 'RelayBridge'
    $migrationFixtureSource = Join-Path $caseRoot 'minimal-release'
    $markers = Join-Path $caseRoot 'markers'
    $outside = Join-Path $caseRoot 'unrelated'
    New-Item -ItemType Directory -Path (Join-Path $installRoot 'mcp'), (Join-Path $installRoot 'data\receipts'),
      (Join-Path $migrationFixtureSource 'config'), (Join-Path $migrationFixtureSource 'tools'),
      (Join-Path $migrationFixtureSource 'lib'), $markers, $outside -Force | Out-Null
    Write-Fixture (Join-Path $installRoot 'server.js') $legacyServer
    Write-Fixture (Join-Path $installRoot '.bridge-token') ('a' * 64)
    Write-Fixture (Join-Path $installRoot '.state.json') '{"fullPermissions":false}'
    Write-Fixture (Join-Path $installRoot 'data\receipts\preserved.jsonl') '{"receiptId":"old-holder-fixture"}'
    $holderScript = Join-Path $installRoot 'mcp\server.mjs'
    # CommonJS helper is written as .mjs via createRequire-free ESM wrapper.
    Write-Fixture $holderScript ($helper.Replace("'use strict';", "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"))
    $ready = Join-Path $caseRoot 'holder-ready.json'; $stop = Join-Path $caseRoot 'holder-stop.txt'
    $nonce = [guid]::NewGuid().ToString('N')
    $controls.Add([pscustomobject]@{ ready=$ready; stop=$stop; nonce=$nonce })
    # Same minimal no-dependency package pattern as the existing migration fixture.
    $package = [ordered]@{ name='relaybridge-migration-fixture'; version='2.0.1'; private=$true;
      scripts=[ordered]@{ preinstall='node fixture-hook.cjs dependencies'; test='node fixture-hook.cjs tests' } }
    Write-Fixture (Join-Path $migrationFixtureSource 'package.json') ($package | ConvertTo-Json -Depth 5)
    Write-Fixture (Join-Path $migrationFixtureSource 'package-lock.json') '{"name":"relaybridge-migration-fixture","version":"2.0.1","lockfileVersion":3,"requires":true,"packages":{"":{"name":"relaybridge-migration-fixture","version":"2.0.1","hasInstallScript":true}}}'
    Write-Fixture (Join-Path $migrationFixtureSource 'fixture-hook.cjs') $hook
    Write-Fixture (Join-Path $migrationFixtureSource 'fixture-settings.json') ([ordered]@{ mode=$mode; markers=$markers; installRoot=$installRoot;
      holderScript=$holderScript; ready=$ready; stop=$stop; nonce=$nonce } | ConvertTo-Json)
    foreach ($relative in @('cli-config.json', 'config\routing-policy.json', 'lib\github-tracker.js', 'lib\platform.js', 'tools\migrate-github-registry.cjs')) {
      Copy-Item -LiteralPath (Join-Path $repoRoot $relative) -Destination (Join-Path $migrationFixtureSource $relative)
    }
    # An unrelated live Node child survives every installer attempt.
    $otherScript = Join-Path $outside 'unrelated.cjs'; Write-Fixture $otherScript $helper
    $otherReady = Join-Path $caseRoot 'other-ready.json'; $otherStop = Join-Path $caseRoot 'other-stop.txt'
    $otherNonce = [guid]::NewGuid().ToString('N'); $controls.Add([pscustomobject]@{ ready=$otherReady; stop=$otherStop; nonce=$otherNonce })
    $other = Start-Process -FilePath $node -ArgumentList ((Quote-Fixture $otherScript) + ' ' + (Quote-Fixture $otherReady) + ' ' + (Quote-Fixture $otherStop) + ' ' + $otherNonce + ' ' + (Quote-Fixture $holderScript)) -WorkingDirectory $outside -WindowStyle Hidden -PassThru
    $null = $other.Handle; $processes.Add($other); $null = Wait-FixtureReady $otherReady
    if ($mode -eq 'early') {
      $holder = Start-Process -FilePath $node -ArgumentList ((Quote-Fixture $holderScript) + ' ' + (Quote-Fixture $ready) + ' ' + (Quote-Fixture $stop) + ' ' + $nonce) -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru
      $null = $holder.Handle; $processes.Add($holder); $null = Wait-FixtureReady $ready
    } else { Assert-True (-not (Test-Path -LiteralPath $ready)) 'staging holder does not exist before installation' }
    $fixturePort = Get-FreePort
    $env:PORT = [string]$fixturePort
    $legacyProcess = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru
    $null = $legacyProcess.Handle; $processes.Add($legacyProcess); $env:PORT = $oldPort
    $beforeHealth = $null
    for ($attempt = 0; $attempt -lt 50 -and -not $beforeHealth; $attempt++) {
      try { $beforeHealth = Get-FixtureHealth $fixturePort } catch { Start-Sleep -Milliseconds 100 }
    }
    Assert-True ($beforeHealth.pid -eq $legacyProcess.Id -and $beforeHealth.version -eq '2.0.0') 'exact existing fake REST process is healthy'
    $beforeTree = Get-TreeFingerprint $installRoot
    $beforeTokenHash = Get-Sha256 (Join-Path $installRoot '.bridge-token')
    $beforeDataHash = Get-Sha256 (Join-Path $installRoot 'data\receipts\preserved.jsonl')
    $result = Invoke-TestInstall -Port $fixturePort -TargetInstallDir $installRoot -InstallSource $migrationFixtureSource
    Assert-True ($result.ExitCode -ne 0 -and $result.Diagnostic -match 'install_root_locked') "typed holder rejection occurs for $mode"
    $phase = if ($mode -eq 'early') { 'preflight' } else { 'before_shutdown' }
    Assert-True ($result.Diagnostic.Contains('"phase":"' + $phase + '"')) "rejection occurs at exact $phase phase"
    $holderReady = Wait-FixtureReady $ready
    Assert-True ($result.Diagnostic -match ('"pid":' + [regex]::Escape([string]$holderReady.pid) + '(?:,|})')) 'diagnostic identifies the owned holder'
    Assert-True ($holderReady.nonce -eq $nonce -and $holderReady.cwd -eq $installRoot) 'staged/early helper is the owned exact install process'
    if ($mode -eq 'early') {
      Assert-True (-not (Test-Path -LiteralPath (Join-Path $markers 'dependencies.entered'))) 'early holder blocks before npm ci lifecycle marker'
      Assert-True (-not (Test-Path -LiteralPath (Join-Path $markers 'tests.entered'))) 'early holder blocks before npm test marker'
    } else {
      foreach ($name in @('dependencies.entered', 'tests.entered', 'tests.completed')) {
        Assert-True (Test-Path -LiteralPath (Join-Path $markers $name)) "real staging reached $name before holder recheck"
      }
    }
    $afterHealth = Get-FixtureHealth $fixturePort
    Assert-True (($afterHealth | ConvertTo-Json -Compress) -ceq ($beforeHealth | ConvertTo-Json -Compress)) 'old REST PID/version/capability identity is unchanged'
    Assert-True (-not $legacyProcess.HasExited -and -not $other.HasExited) 'old REST and unrelated Node were never terminated'
    Assert-True ((Get-TreeFingerprint $installRoot) -ceq $beforeTree) 'entire authoritative install tree is unchanged'
    Assert-True ((Get-Sha256 (Join-Path $installRoot '.bridge-token')) -ceq $beforeTokenHash) 'capability token bytes unchanged'
    Assert-True ((Get-Sha256 (Join-Path $installRoot 'data\receipts\preserved.jsonl')) -ceq $beforeDataHash) 'receipt/data bytes unchanged'
    Assert-True (@(Get-ChildItem -LiteralPath $caseRoot -Directory | Where-Object { $_.Name -like 'RelayBridge.stage.*' -or $_.Name -like 'RelayBridge.rollback.*' -or $_.Name -like 'RelayBridge.failed.*' }).Count -eq 0) 'failed preflight leaves no cutover or quarantined authority root'
    Write-Host ('PASS ' + $mode + ': phase=' + $phase + '; same old REST PID; token/data/tree unchanged; markers verified; unrelated Node alive.')
    # Per-case cleanup uses private fixture controls and the retained REST handle.
    Write-Fixture $stop $nonce; Write-Fixture $otherStop $otherNonce
    $legacyProcess.Kill(); $legacyProcess.WaitForExit()
  }
} finally {
  $env:PORT = $oldPort
  foreach ($control in $controls) { if (Test-Path -LiteralPath (Split-Path $control.stop -Parent)) { Write-Fixture $control.stop $control.nonce } }
  foreach ($process in $processes) {
    try { if (-not $process.HasExited -and -not $process.WaitForExit(5000)) { $process.Kill(); $process.WaitForExit() } } finally { $process.Dispose() }
  }
  # Staging-created children use their private stop file; read their PID only to
  # wait for exit, never to kill or modify an unpinned process.
  foreach ($control in $controls) {
    if (-not (Test-Path -LiteralPath $control.ready)) { continue }
    $entry = [IO.File]::ReadAllText($control.ready) | ConvertFrom-Json
    if ($entry.nonce -ne $control.nonce) { throw 'fixture cleanup identity mismatch' }
    $process = $null
    try { $process = [Diagnostics.Process]::GetProcessById([int]$entry.pid); $null = $process.Handle } catch { continue }
    try { if (-not $process.WaitForExit(5000)) { throw 'test-owned control stop did not settle; retaining fixture directory' } } finally { $process.Dispose() }
  }
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
Write-Host 'PASS: both native #105 lifecycle acceptance scenarios completed and fixture processes cleaned.'

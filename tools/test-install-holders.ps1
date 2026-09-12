[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RepositoryRoot)
# Native Windows PowerShell 5.1 regression; fixtures own all created processes.
# Imports production helper definitions only; never dot-sources installer main.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $RepositoryRoot 'install.ps1'
$names = @('Get-NormalizedPath', 'Test-SamePath', 'Split-WindowsCommandLine',
  'ConvertTo-InstallMcpHolder', 'Get-InstallMcpProcessRows', 'Get-InstallMcpHolders',
  'Assert-InstallRootMcpAvailable')
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$null)
$definitions = @{}
foreach ($function in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  if ($names -contains $function.Name) { $definitions[$function.Name] = $function.Extent.Text }
}
foreach ($name in $names) {
  if (-not $definitions.ContainsKey($name)) { throw "Production helper missing: $name" }
}
. ([scriptblock]::Create(($names | ForEach-Object { $definitions[$_] }) -join "`n"))
function Assert-Fixture([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "ASSERTION FAILED: $Message" } }
function Quote-FixturePath([string]$Value) {
  if ($Value.Contains('"')) { throw 'fixture paths may not contain embedded quotes' }
  return '"' + $Value + '"'
}
function Get-FixtureFingerprint([string]$Root) {
  return (@(Get-ChildItem -LiteralPath $Root -Recurse -File | Sort-Object FullName | ForEach-Object {
    $_.FullName.Substring($Root.Length) + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
  }) -join "`n")
}
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('rb holder proof ' + [guid]::NewGuid().ToString('N'))
$installRoot = Join-Path $fixtureRoot 'RelayBridge'
$outside = Join-Path $fixtureRoot 'unrelated'
$owned = @()
$oldErrorPath = $env:RELAYBRIDGE_INSTALL_TEST_ERROR_FILE
try {
  New-Item -ItemType Directory -Path (Join-Path $installRoot 'mcp'), (Join-Path $installRoot 'data\receipts'), $outside -Force | Out-Null
  $helper = @'
import fs from 'node:fs';
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, cwd: process.cwd() }));
setInterval(() => {}, 1000);
'@
  $adapter = Join-Path $installRoot 'mcp\server.mjs'
  $launcher = Join-Path $installRoot 'mcp\launcher.mjs'
  $other = Join-Path $outside 'unrelated.mjs'
  foreach ($script in @($adapter, $launcher, $other)) { [IO.File]::WriteAllText($script, $helper, [Text.UTF8Encoding]::new($false)) }
  [IO.File]::WriteAllText((Join-Path $installRoot '.bridge-token'), (('a' * 64) + "`n"))
  [IO.File]::WriteAllText((Join-Path $installRoot 'data\receipts\fixture.json'), '{"receiptId":"preserved-fixture"}')
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $adapterReady = Join-Path $fixtureRoot 'adapter-ready.json'
  $launcherReady = Join-Path $fixtureRoot 'launcher-ready.json'
  $otherReady = Join-Path $fixtureRoot 'other-ready.json'
  $first = Start-Process -FilePath $node -ArgumentList ((Quote-FixturePath $adapter) + ' ' + (Quote-FixturePath $adapterReady)) -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru
  $null = $first.Handle; $owned += $first
  $second = Start-Process -FilePath $node -ArgumentList ((Quote-FixturePath $launcher) + ' ' + (Quote-FixturePath $launcherReady)) -WorkingDirectory $installRoot -WindowStyle Hidden -PassThru
  $null = $second.Handle; $owned += $second
  # The target path appears only as a later argument: this unrelated process must be ignored.
  $third = Start-Process -FilePath $node -ArgumentList ((Quote-FixturePath $other) + ' ' + (Quote-FixturePath $otherReady) + ' ' + (Quote-FixturePath $adapter) + ' fixture-secret-never-in-diagnostic') -WorkingDirectory $outside -WindowStyle Hidden -PassThru
  $null = $third.Handle; $owned += $third
  foreach ($ready in @($adapterReady, $launcherReady, $otherReady)) {
    for ($attempt = 0; $attempt -lt 100 -and -not (Test-Path -LiteralPath $ready); $attempt++) { Start-Sleep -Milliseconds 50 }
    Assert-Fixture (Test-Path -LiteralPath $ready) "owned helper should reach ready: $ready"
  }
  Assert-Fixture ((Get-Content -LiteralPath $adapterReady -Raw | ConvertFrom-Json).cwd -eq $installRoot) 'adapter has known native cwd under the exact temporary install'
  Assert-Fixture ((Get-Content -LiteralPath $launcherReady -Raw | ConvertFrom-Json).cwd -eq $installRoot) 'launcher has known native cwd under the exact temporary install'
  $evidence = Get-InstallMcpHolders $installRoot
  $pids = @($evidence.holders | ForEach-Object { [int]$_.pid } | Sort-Object)
  $expected = @($first.Id, $second.Id | Sort-Object)
  Assert-Fixture (($pids -join ',') -eq ($expected -join ',')) 'only exact adapter and launcher scripts match; later unrelated argument must not match'
  $diagnostic = ''
  try { Assert-InstallRootMcpAvailable $installRoot 'preflight' } catch { $diagnostic = $_.Exception.ToString() }
  Assert-Fixture ($diagnostic -match 'install_root_locked') 'assertion has typed failure class'
  Assert-Fixture ($diagnostic -match [regex]::Escape([string]$first.Id) -and $diagnostic -match [regex]::Escape([string]$second.Id)) 'bounded diagnostics name both owned holder PIDs'
  Assert-Fixture (-not $diagnostic.Contains('fixture-secret-never-in-diagnostic')) 'unrelated arguments are never printed'
  Assert-Fixture (-not $first.HasExited -and -not $second.HasExited -and -not $third.HasExited) 'preflight never kills any process'
  $fingerprint = Get-FixtureFingerprint $installRoot
  # A missing source is deliberate: absent preflight, this fails before dependency work.
  # With preflight, exact install_root_locked must win before source validation.
  $errorPath = Join-Path $fixtureRoot 'installer-error.txt'
  $env:RELAYBRIDGE_INSTALL_TEST_ERROR_FILE = $errorPath
  $args = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Quote-FixturePath $installer),
    '-SourceDir', (Quote-FixturePath (Join-Path $fixtureRoot 'intentionally-missing-source')),
    '-InstallDir', (Quote-FixturePath $installRoot), '-SkipProviderSetup', '-SkipCliPathRegistration', '-NoBrowser', '-NoStart')
  $installProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden -PassThru
  try {
    Assert-Fixture ($installProcess.WaitForExit(15000)) 'blocked installer exits within bounded native smoke deadline'
    Assert-Fixture ($installProcess.ExitCode -ne 0) 'blocked update fails before staging'
  } finally {
    if (-not $installProcess.HasExited) { $installProcess.Kill(); $installProcess.WaitForExit() }
    $installProcess.Dispose()
  }
  Assert-Fixture (Test-Path -LiteralPath $errorPath) 'inside-try preflight preserves installer diagnostic hook'
  $installDiagnostic = [IO.File]::ReadAllText($errorPath)
  Assert-Fixture ($installDiagnostic -match 'install_root_locked') 'holder failure occurs before missing source validation'
  Assert-Fixture (-not ($installDiagnostic -match 'SourceDir is not a directory')) 'source validation must not run before holder preflight'
  Assert-Fixture ((Get-FixtureFingerprint $installRoot) -ceq $fingerprint) 'preflight preserves every install/token/receipt byte'
  Assert-Fixture (-not $first.HasExited -and -not $second.HasExited -and -not $third.HasExited) 'full installer preflight does not stop holders or unrelated Node'
  $first.Kill(); $first.WaitForExit(); $second.Kill(); $second.WaitForExit()
  Assert-InstallRootMcpAvailable $installRoot 'clean_retry'
  Assert-Fixture (-not $third.HasExited) 'unrelated Node with target path as argument neither blocks nor is stopped'
  Write-Host 'PASS: exact native holders, bounded redaction, early full-installer rejection, byte preservation, clean preflight retry.'
  Write-Host 'NOT COVERED: live REST unchanged/restarted, dependency marker, staging/shutdown race, successful version cutover; use tools/test-install.ps1 on Windows CI.'
} finally {
  $env:RELAYBRIDGE_INSTALL_TEST_ERROR_FILE = $oldErrorPath
  foreach ($process in $owned) {
    try { if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() } } finally { $process.Dispose() }
  }
  if (Test-Path -LiteralPath $fixtureRoot) { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force }
}

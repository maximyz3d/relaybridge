[CmdletBinding()]
param(
  [switch]$SafetyOnly
)

$ErrorActionPreference = 'Stop'
if ($env:RELAYBRIDGE_SKIP_INSTALL_TEST -eq '1') {
  Write-Host '[RelayBridge] Nested install test skipped.' -ForegroundColor DarkGray
  exit 0
}

$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
$releaseVersion = [string](([IO.File]::ReadAllText((Join-Path $repoRoot 'package.json')) | ConvertFrom-Json).version)
$releaseBuildIdPattern = '^' + [regex]::Escape($releaseVersion) + '\+[a-f0-9]{16}$'
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

function Test-ProcessRunning([int]$ProcessId) {
  if ($ProcessId -le 0) { return $false }
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    return (-not $process.HasExited)
  } catch { return $false }
}

function Invoke-TestInstall(
  [string]$FailAt = '',
  [switch]$Start,
  [int]$Port = 0,
  [string]$TargetInstallDir = '',
  [string]$MigrationSource = '',
  [string]$InstallSource = '',
  [switch]$FailRollbackCleanup
) {
  if (-not $Port) { $Port = Get-FreePort }
  if (-not $TargetInstallDir) { $TargetInstallDir = $installRoot }
  if (-not $InstallSource) { $InstallSource = $repoRoot }
  $previousFailAt = $env:RELAYBRIDGE_INSTALL_TEST_FAIL_AT
  $previousFailRollbackCleanup = $env:RELAYBRIDGE_INSTALL_TEST_FAIL_ROLLBACK_CLEANUP
  $previousErrorFile = $env:RELAYBRIDGE_INSTALL_TEST_ERROR_FILE
  $previousGitHubRegistry = $env:RELAYBRIDGE_GITHUB_REPOS
  $previousDataDir = $env:RELAYBRIDGE_DATA_DIR
  $previousPsDataDir = $env:PS_BRIDGE_DATA_DIR
  $errorFile = Join-Path $testRoot ('install-error-' + [Guid]::NewGuid().ToString('N') + '.txt')
  try {
    $env:RELAYBRIDGE_INSTALL_TEST_FAIL_AT = $FailAt
    $env:RELAYBRIDGE_INSTALL_TEST_FAIL_ROLLBACK_CLEANUP = if ($FailRollbackCleanup) { '1' } else { $null }
    $env:RELAYBRIDGE_INSTALL_TEST_ERROR_FILE = $errorFile
    # Host-specific runtime paths must never leak into the disposable Windows
    # fixture (especially when this script is launched through powershell.exe
    # from WSL and inherited a /home/... override).
    $env:RELAYBRIDGE_GITHUB_REPOS = $null
    $env:RELAYBRIDGE_DATA_DIR = $null
    $env:PS_BRIDGE_DATA_DIR = $null
    $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer,
      '-SourceDir', $InstallSource, '-InstallDir', $TargetInstallDir, '-SkipProviderSetup', '-SkipCliPathRegistration', '-NoBrowser', '-Port', [string]$Port)
    if ($MigrationSource) { $arguments += @('-MigrateFrom', $MigrationSource) }
    if (-not $Start) { $arguments += '-NoStart' }
    # Do not pipe or redirect the child PowerShell output. On Windows a
    # detached candidate server can inherit the pipeline/file handle, keeping
    # the test blocked even after install.ps1 itself has exited. Waiting on the
    # direct process handle still gives us the installer's real exit code.
    $proc = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
    $proc.WaitForExit()
    $exitCode = [int]$proc.ExitCode
    $proc.Dispose()
    $diagnostic = if (Test-Path -LiteralPath $errorFile -PathType Leaf) {
      [IO.File]::ReadAllText($errorFile, [Text.UTF8Encoding]::new($false)).Trim()
    } else { '' }
    if ($exitCode -ne 0) {
      $boundedDiagnostic = if ($diagnostic) { $diagnostic.Substring(0, [Math]::Min(12000, $diagnostic.Length)) } else { '(child installer produced no diagnostic file)' }
      Write-Host "[RelayBridge test] installer exit=$exitCode failpoint=$FailAt port=$Port`n$boundedDiagnostic"
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Port = $Port; Diagnostic = $diagnostic }
  } finally {
    $env:RELAYBRIDGE_INSTALL_TEST_FAIL_AT = $previousFailAt
    $env:RELAYBRIDGE_INSTALL_TEST_FAIL_ROLLBACK_CLEANUP = $previousFailRollbackCleanup
    $env:RELAYBRIDGE_INSTALL_TEST_ERROR_FILE = $previousErrorFile
    $env:RELAYBRIDGE_GITHUB_REPOS = $previousGitHubRegistry
    $env:RELAYBRIDGE_DATA_DIR = $previousDataDir
    $env:PS_BRIDGE_DATA_DIR = $previousPsDataDir
  }
}

# Shipped release metadata has to be correctable by an upgrade, because config
# preservation otherwise keeps an installed mistake forever. Each migration
# must be exactly as narrow as it claims. The full install below proves the
# end-to-end path; these cases exercise branches one install cannot reach at
# once, by loading the real functions straight out of install.ps1.
function Get-InstallerFunctionText([string[]]$Names) {
  # Dot-sourcing has to happen in the script scope, so hand the caller the text
  # rather than defining the functions inside this one and losing them on return.
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$null)
  $functions = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
  }, $true)
  $functionText = @{}
  $functionCounts = @{}
  foreach ($functionAst in $functions) {
    $functionName = [string]$functionAst.Name
    $functionCounts[$functionName] = 1 + [int]$functionCounts[$functionName]
    $functionText[$functionName] = $functionAst.Extent.Text
  }
  $blocks = @()
  foreach ($requestedName in $Names) {
    $foundCount = [int]$functionCounts[$requestedName]
    if ($foundCount -ne 1) { throw "install.ps1 must define exactly one $requestedName function (found $foundCount)." }
    $blocks += $functionText[$requestedName]
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

function Test-CopilotMetadataMigration([string]$InstalledProviderJson) {
  $defaults = @'
{
  "_config_merge": {
    "managed_credential_relocations": {
      "copilot": {
        "retired_env_without_markers": "GH_CONFIG_DIR",
        "retired_pair": { "credential_env": "GH_CONFIG_DIR", "credential_markers": ["hosts.yml"] }
      }
    },
    "managed_login_commands": {
      "copilot": { "retired_command": ["copilot", "/login"] }
    }
  },
  "copilot": {
    "credential_env": "COPILOT_HOME",
    "credential_markers": ["config.json"],
    "login_command": ["copilot", "login"]
  }
}
'@ | ConvertFrom-Json
  $installedJson = '{ "copilot": ' + $InstalledProviderJson + ' }'
  $existing = $installedJson | ConvertFrom-Json
  $merged = $installedJson | ConvertFrom-Json
  $merged = Restore-ShippedCredentialRelocation $merged $defaults $existing
  return (Restore-ShippedManagedLoginCommands $merged $defaults $existing).copilot
}

function Test-RequiredStripEnvMigration([string]$InstalledStripEnvJson) {
  $defaults = @'
{
  "_config_merge": { "managed_required_strip_env": ["copilot"] },
  "copilot": { "strip_env": ["GITHUB_TOKEN", "GITHUB_COPILOT_API_TOKEN", "COPILOT_PROVIDER_BASE_URL"] }
}
'@ | ConvertFrom-Json
  $installedJson = '{ "copilot": { "strip_env": ' + $InstalledStripEnvJson + ' } }'
  $merged = $installedJson | ConvertFrom-Json
  return (Restore-ShippedRequiredStripEnv $merged $defaults).copilot.strip_env
}

. ([scriptblock]::Create((Get-InstallerFunctionText @(
  'Test-ExactJsonStringArray', 'Restore-ShippedCredentialRelocation', 'Restore-ShippedManagedLoginCommands',
  'Restore-ShippedRequiredStripEnv',
  'Test-RetiredJsonNumber', 'Format-JsonScalar', 'Restore-ShippedManagedSupervisorBudget',
  'Test-ReleasePathExcluded', 'Test-SecretLikeReleasePath', 'Assert-ReleaseItemSafe',
  'Copy-ReleaseSource', 'Get-ReleaseIdentityFiles', 'Get-BridgeHealth',
  'Test-LocalPortInUse', 'Start-StagedBridge',
  'Move-InstallDirectoryOnce', 'Move-InstallRootForCutover',
  'Get-BridgeShutdownProcessHandle', 'Stop-BridgeForCutover'
))))

# Test the real no-replace primitive, then deterministic bounded retry paths.
# Mocks live only in child scopes and cannot affect the full transaction below.
$cutoverFixture = Join-Path $testRoot 'cutover-primitive'
$cutoverSource = Join-Path $cutoverFixture 'source'
$cutoverDestination = Join-Path $cutoverFixture 'destination'
New-Item -ItemType Directory -Path $cutoverSource, $cutoverDestination -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $cutoverSource 'original'), 'source bytes')
[IO.File]::WriteAllText((Join-Path $cutoverDestination 'original'), 'destination bytes')
$collisionRejected = $false
try { Move-InstallRootForCutover $cutoverSource $cutoverDestination }
catch { $collisionRejected = $true }
Assert-True $collisionRejected 'an existing cutover destination must reject, never nest or overwrite'
Assert-True ([IO.File]::ReadAllText((Join-Path $cutoverSource 'original')) -ceq 'source bytes') 'collision must preserve source bytes'
Assert-True ([IO.File]::ReadAllText((Join-Path $cutoverDestination 'original')) -ceq 'destination bytes') 'collision must preserve destination bytes'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $cutoverDestination 'source'))) 'collision must not nest the source'
& {
  $counter = @{ attempts = 0; pauses = 0 }
  function Start-Sleep([int]$Milliseconds) {
    Assert-True ($Milliseconds -eq 100) 'cutover retry pause must remain bounded'
    $counter.pauses++
  }
  function Move-InstallDirectoryOnce([string]$FromRoot, [string]$ToRoot) {
    $counter.attempts++
    if ($counter.attempts -le 2) { throw [IO.IOException]::new('sharing violation', -2147024864) }
    [IO.Directory]::Move($FromRoot, $ToRoot)
  }
  $target = Join-Path $cutoverFixture 'transient-result'
  Move-InstallRootForCutover $cutoverSource $target
  Assert-True ($counter.attempts -eq 3 -and $counter.pauses -eq 2) 'transient sharing retries must stop immediately on success'
  Assert-True ([IO.File]::ReadAllText((Join-Path $target 'original')) -ceq 'source bytes') 'successful retry must preserve exact bytes'
}
& {
  $counter = @{ attempts = 0; pauses = 0 }
  function Start-Sleep([int]$Milliseconds) { $counter.pauses++ }
  function Move-InstallDirectoryOnce([string]$FromRoot, [string]$ToRoot) {
    $counter.attempts++
    throw [IO.IOException]::new('persistent sharing violation', -2147024864)
  }
  $rejected = $false
  try { Move-InstallRootForCutover $cutoverSource $cutoverDestination }
  catch { $rejected = $true }
  Assert-True ($rejected -and $counter.attempts -eq 50 -and $counter.pauses -eq 49) 'persistent sharing retries must exhaust exactly the bounded attempt count'
}
& {
  $counter = @{ attempts = 0 }
  function Start-Sleep([int]$Milliseconds) { throw 'non-sharing error must never retry' }
  function Move-InstallDirectoryOnce([string]$FromRoot, [string]$ToRoot) {
    $counter.attempts++
    throw [IO.IOException]::new('access denied', -2147024891)
  }
  $rejected = $false
  try { Move-InstallRootForCutover $cutoverSource $cutoverDestination }
  catch { $rejected = $true }
  Assert-True ($rejected -and $counter.attempts -eq 1) 'non-sharing errors must fail immediately'
}
& {
  $counter = @{ attempts = 0 }
  function Start-Sleep([int]$Milliseconds) {}
  function Move-InstallDirectoryOnce([string]$FromRoot, [string]$ToRoot) {
    $counter.attempts++
    if ($counter.attempts -eq 1) {
      New-Item -ItemType Directory -Path $ToRoot | Out-Null
      throw [IO.IOException]::new('sharing violation before racing destination', -2147024864)
    }
    [IO.Directory]::Move($FromRoot, $ToRoot)
  }
  $source = Join-Path $cutoverFixture 'race-source'
  $target = Join-Path $cutoverFixture 'race-destination'
  New-Item -ItemType Directory -Path $source | Out-Null
  [IO.File]::WriteAllText((Join-Path $source 'original'), 'racing source bytes')
  $rejected = $false
  try { Move-InstallRootForCutover $source $target }
  catch { $rejected = $true }
  Assert-True ($rejected -and $counter.attempts -eq 2) 'a destination appearing between retries must reject atomically'
  Assert-True ([IO.File]::ReadAllText((Join-Path $source 'original')) -ceq 'racing source bytes') 'racing destination must leave source unchanged'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $target 'race-source'))) 'racing destination must never nest the source'
}
Remove-Item -LiteralPath $cutoverFixture -Recurse -Force
Write-Host '[RelayBridge] Atomic cutover collision and bounded retry tests passed.' -ForegroundColor DarkGray

# Legacy enrollment is authority state. The installer must hand the original
# post-cutover path to the hardened Node helper, never probe or copy it through
# PowerShell (which would follow a reparse point before descriptor validation).
$installerSource = [IO.File]::ReadAllText($installer, [Text.UTF8Encoding]::new($false))
$migrationFunctionSource = Get-InstallerFunctionText @('Migrate-LegacyGitHubRegistry')
Assert-True (-not $migrationFunctionSource.Contains('Test-Path -LiteralPath $LegacyFile')) 'the migration wrapper must not preflight the legacy registry'
Assert-True ($migrationFunctionSource -notmatch '\bCopy-Item\b') 'the migration wrapper must not copy the legacy registry'
Assert-True ($migrationFunctionSource.Contains("if (`$LegacyFile) { `$args += @('--legacy-file', `$LegacyFile) }")) 'the migration wrapper must always delegate a supplied legacy path to the hardened helper'
Assert-True (-not $installerSource.Contains('$legacyRegistrySnapshot')) 'the installer must not create a PowerShell legacy-registry snapshot'
Assert-True ($installerSource.Contains("Join-Path `$backupRoot 'config\github-repos.json'")) 'an existing InstallDir must be read from its rollback root after cutover'
Assert-True ($installerSource.Contains("Join-Path `$MigrateFrom 'config\github-repos.json'")) 'an explicit MigrateFrom legacy registry must remain at its unchanged source path'
Assert-True ($installerSource.Contains('Migrate-LegacyGitHubRegistry $InstallDir $legacyRegistrySource')) 'the post-cutover migration must use the mapped source path'
$promotionIndex = $installerSource.IndexOf("Assert-NoInjectedInstallFailure 'after-promote'", [StringComparison]::Ordinal)
$migrationIndex = $installerSource.IndexOf('Migrate-LegacyGitHubRegistry $InstallDir $legacyRegistrySource', $promotionIndex, [StringComparison]::Ordinal)
$candidateStartIndex = $installerSource.IndexOf('if (-not $NoStart)', $promotionIndex, [StringComparison]::Ordinal)
Assert-True ($promotionIndex -ge 0 -and $migrationIndex -gt $promotionIndex -and $candidateStartIndex -gt $migrationIndex) 'legacy migration must run immediately after promotion and before candidate startup'
Write-Host '[RelayBridge] Hardened legacy-registry installer delegation passed.' -ForegroundColor DarkGray

$retiredCopilot = Test-CopilotMetadataMigration '{ "credential_env": "GH_CONFIG_DIR", "credential_markers": ["hosts.yml"], "login_command": ["copilot", "/login"] }'
Assert-True ($retiredCopilot.credential_env -ceq 'COPILOT_HOME') 'the exact retired Copilot environment variable must migrate'
Assert-True ((Test-ExactJsonStringArray $retiredCopilot.credential_markers @('config.json'))) 'the exact retired Copilot marker must migrate'
Assert-True ((Test-ExactJsonStringArray $retiredCopilot.login_command @('copilot', 'login'))) 'the exact retired Copilot login command must migrate'

$releasedCopilot = Test-CopilotMetadataMigration '{ "credential_env": "GH_CONFIG_DIR", "login_command": ["copilot", "/login"] }'
Assert-True ($releasedCopilot.credential_env -ceq 'COPILOT_HOME') 'the released Copilot declaration without markers must migrate'
Assert-True ((Test-ExactJsonStringArray $releasedCopilot.credential_markers @('config.json'))) 'the released Copilot declaration must gain the real marker'

$customCopilotEnv = Test-CopilotMetadataMigration '{ "credential_env": "OPERATOR_COPILOT_HOME", "credential_markers": ["hosts.yml"], "login_command": ["copilot", "/login"] }'
Assert-True ($customCopilotEnv.credential_env -ceq 'OPERATOR_COPILOT_HOME') 'a custom Copilot environment variable must be preserved'
Assert-True ((Test-ExactJsonStringArray $customCopilotEnv.credential_markers @('hosts.yml'))) 'a partially edited relocation pair must remain operator-owned'

$customCopilotMarkers = Test-CopilotMetadataMigration '{ "credential_env": "GH_CONFIG_DIR", "credential_markers": ["hosts.yml", "operator.json"], "login_command": ["copilot", "/login"] }'
Assert-True ($customCopilotMarkers.credential_env -ceq 'GH_CONFIG_DIR') 'the retired environment variable must not migrate beside custom markers'
Assert-True ((Test-ExactJsonStringArray $customCopilotMarkers.credential_markers @('hosts.yml', 'operator.json'))) 'custom Copilot markers must be preserved'

$customCopilotLogin = Test-CopilotMetadataMigration '{ "credential_env": "GH_CONFIG_DIR", "credential_markers": ["hosts.yml"], "login_command": ["operator-wrapper", "copilot-login"] }'
Assert-True ((Test-ExactJsonStringArray $customCopilotLogin.login_command @('operator-wrapper', 'copilot-login'))) 'a custom Copilot login command must be preserved'
Write-Host '[RelayBridge] Managed Copilot metadata migration cases passed.' -ForegroundColor DarkGray

$requiredStrip = @(Test-RequiredStripEnvMigration '["GITHUB_TOKEN", "OPERATOR_EXTRA"]')
Assert-True (($requiredStrip -join ',') -ceq 'GITHUB_TOKEN,OPERATOR_EXTRA,GITHUB_COPILOT_API_TOKEN,COPILOT_PROVIDER_BASE_URL') 'required environment exclusions must append without replacing operator extras'
$caseInsensitiveStrip = @(Test-RequiredStripEnvMigration '["github_token", "GITHUB_COPILOT_API_TOKEN", "COPILOT_PROVIDER_BASE_URL"]')
Assert-True ($caseInsensitiveStrip.Count -eq 3) 'a differently-cased exclusion must not be duplicated on Windows'
Assert-True ($caseInsensitiveStrip[0] -ceq 'github_token') 'the operator spelling and order of an existing exclusion must be preserved'
Write-Host '[RelayBridge] Required provider environment-exclusion migration cases passed.' -ForegroundColor DarkGray

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

$copyFixture = Join-Path $testRoot 'copy-safety'
$copySource = Join-Path $copyFixture 'source'
$copyStage = Join-Path $copyFixture 'stage'
$copyExternal = Join-Path $copyFixture 'external'
New-Item -ItemType Directory -Path $copySource, $copyExternal -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $copySource 'keep.txt'), "release bytes`n", [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $copyExternal 'outside-secret.txt'), "must never be staged`n", [Text.UTF8Encoding]::new($false))
$junction = Join-Path $copySource 'junction-escape'
New-Item -ItemType Junction -Path $junction -Target $copyExternal | Out-Null
$junctionRejected = $false
try { Copy-ReleaseSource $copySource $copyStage }
catch { $junctionRejected = $_.Exception.Message -match 'reparse point' }
Assert-True $junctionRejected 'release staging must reject a directory junction instead of following it outside SourceDir'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $copyStage 'junction-escape\outside-secret.txt'))) 'junction target bytes must never reach staging'
[IO.Directory]::Delete($junction)
if (Test-Path -LiteralPath $copyStage) { Remove-Item -LiteralPath $copyStage -Recurse -Force }

foreach ($runtimeName in @('.bridge.pid', '.bridge.8787.pid', 'mcp-config.json', '.build-info.1.test.tmp', 'bridge.start.out.log')) {
  [IO.File]::WriteAllText((Join-Path $copySource $runtimeName), "runtime-only`n", [Text.UTF8Encoding]::new($false))
}
New-Item -ItemType Directory -Path (Join-Path $copySource 'config') -Force | Out-Null
$legacySourceBytes = "{`"repos`": [{`"name`": `"machine/private`", `"path`": `"C:\\private\\checkout`"}]}`n"
[IO.File]::WriteAllText((Join-Path $copySource 'config\github-repos.json'), $legacySourceBytes, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $copySource 'config\github-repos.example.json'), "{`"repos`": []}`n", [Text.UTF8Encoding]::new($false))
New-Item -ItemType Directory -Path (Join-Path $copySource '.mcp-install.lock') -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $copySource '.mcp-install.lock\owner'), "runtime-lock-owner`n", [Text.UTF8Encoding]::new($false))
Copy-ReleaseSource $copySource $copyStage
Assert-True (Test-Path -LiteralPath (Join-Path $copyStage 'keep.txt') -PathType Leaf) 'ordinary release source must still be staged'
foreach ($runtimeName in @('.bridge.pid', '.bridge.8787.pid', 'mcp-config.json', '.build-info.1.test.tmp', 'bridge.start.out.log')) {
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $copyStage $runtimeName))) "runtime artifact must be excluded from staging: $runtimeName"
}
Assert-True (-not (Test-Path -LiteralPath (Join-Path $copyStage '.mcp-install.lock'))) 'MCP registration lock directory must be excluded from release staging'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $copyStage 'config\github-repos.json'))) 'source staging must omit exact legacy machine enrollment before reading or copying its bytes'
Assert-True (Test-Path -LiteralPath (Join-Path $copyStage 'config\github-repos.example.json') -PathType Leaf) 'the exact exclusion must retain the similarly named tracked example'
$identityPaths = @(Get-ReleaseIdentityFiles $copyStage | ForEach-Object {
  $_.FullName.Substring($copyStage.Length).TrimStart('\', '/').Replace('\', '/')
})
Assert-True ($identityPaths.Count -eq 2 -and $identityPaths -contains 'keep.txt' -and $identityPaths -contains 'config/github-repos.example.json') 'release identity enumeration must share the exact staging exclusions'

[IO.File]::WriteAllText((Join-Path $copySource '.npmrc'), "//registry.example.invalid/:_authToken=must-not-be-read`n", [Text.UTF8Encoding]::new($false))
$secretRejected = $false
try { Copy-ReleaseSource $copySource (Join-Path $copyFixture 'secret-stage') }
catch { $secretRejected = $_.Exception.Message -match 'secret-looking path' }
Assert-True $secretRejected 'release staging must reject a nonignored secret-looking path before copying it'
Assert-True (-not (Test-Path -LiteralPath (Join-Path $copyFixture 'secret-stage\.npmrc'))) 'secret-looking bytes must never reach staging'
foreach ($secretName in @('accesstoken.json', 'refreshcredential.toml', 'auth-secret.txt')) {
  Assert-True (Test-SecretLikeReleasePath $secretName) "Windows release staging must match the shared secret policy: $secretName"
}
foreach ($sourceName in @('tokens.ts', 'credential.py', 'design-secrets.md')) {
  Assert-True (-not (Test-SecretLikeReleasePath $sourceName)) "ordinary source must not be rejected as a secret: $sourceName"
}
Write-Host '[RelayBridge] Confined release staging and runtime-exclusion cases passed.' -ForegroundColor DarkGray

$candidateRoot = Join-Path $copyFixture 'unready-candidate'
New-Item -ItemType Directory -Path $candidateRoot -Force | Out-Null
$unreadyServer = @'
'use strict';
const http = require('http');
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    capabilityAuth: true,
    buildId: '2.0.1+aaaaaaaaaaaaaaaa',
    buildIdentityReady: false,
    receiptStoreIdentityReady: true,
    receiptStoreId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  }));
});
server.listen(Number(process.env.PORT), '127.0.0.1');
'@
[IO.File]::WriteAllText((Join-Path $candidateRoot 'server.js'), ($unreadyServer + "`n"), [Text.UTF8Encoding]::new($false))
$candidatePort = Get-FreePort
$candidateRejected = $false
try { Start-StagedBridge $candidateRoot $candidatePort '2.0.1+aaaaaaaaaaaaaaaa' | Out-Null }
catch { $candidateRejected = $true }
Assert-True $candidateRejected 'Windows installer candidate validation must reject buildIdentityReady:false even when buildId matches'
for ($attempt = 0; $attempt -lt 30 -and (Test-LocalPortInUse $candidatePort); $attempt++) { Start-Sleep -Milliseconds 100 }
Assert-True (-not (Test-LocalPortInUse $candidatePort)) 'rejected unready Windows candidate must be terminated'
Write-Host '[RelayBridge] Windows candidate readiness rejection passed.' -ForegroundColor DarkGray

# A candidate can lose the bind race to a detached process that reports the
# same build. Build identity alone cannot prove that the process returned by
# Start-Process owns the listener, so candidate promotion must also require the
# exact spawned PID and terminate only that rejected candidate.
$portWinnerRoot = Join-Path $copyFixture 'same-build-port-winner'
New-Item -ItemType Directory -Path $portWinnerRoot -Force | Out-Null
$raceCandidatePidPath = Join-Path $portWinnerRoot '.bridge.race-candidate.pid'
$raceWinnerPidPath = Join-Path $portWinnerRoot '.bridge.race-winner.pid'
$raceBuildId = '2.0.1+bbbbbbbbbbbbbbbb'
$raceCandidateServer = @'
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
fs.writeFileSync(path.join(__dirname, '.bridge.race-candidate.pid'), String(process.pid));
const winner = spawn(process.execPath, [path.join(__dirname, 'winner.js')], {
  cwd: __dirname,
  env: process.env,
  detached: true,
  stdio: 'ignore',
  windowsHide: true
});
fs.writeFileSync(path.join(__dirname, '.bridge.race-winner.pid'), String(winner.pid));
winner.unref();
setInterval(() => {}, 1000);
'@
$raceWinnerServer = @'
'use strict';
const http = require('http');
const buildId = process.env.RELAYBRIDGE_EXPECTED_BUILD_ID;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    pid: process.pid,
    capabilityAuth: true,
    buildId,
    buildIdentityReady: true,
    receiptStoreIdentityReady: true,
    receiptStoreId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  }));
});
server.listen(Number(process.env.PORT), '127.0.0.1');
'@
[IO.File]::WriteAllText((Join-Path $portWinnerRoot 'server.js'), ($raceCandidateServer + "`n"), [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $portWinnerRoot 'winner.js'), ($raceWinnerServer + "`n"), [Text.UTF8Encoding]::new($false))
$racePort = Get-FreePort
$raceRejected = $false
$raceDiagnostic = ''
$raceCandidatePid = 0
$raceWinnerPid = 0
$raceCandidateStopped = $false
$raceWinnerHealthMatched = $false
$raceListenerCleaned = $false
$racePidArtifactsCleaned = $false
try {
  try { Start-StagedBridge $portWinnerRoot $racePort $raceBuildId | Out-Null }
  catch {
    $raceRejected = $true
    $raceDiagnostic = $_.Exception.Message
  }
  if (Test-Path -LiteralPath $raceCandidatePidPath -PathType Leaf) {
    $raceCandidatePid = [int]([IO.File]::ReadAllText($raceCandidatePidPath).Trim())
  }
  if (Test-Path -LiteralPath $raceWinnerPidPath -PathType Leaf) {
    $raceWinnerPid = [int]([IO.File]::ReadAllText($raceWinnerPidPath).Trim())
  }
  for ($attempt = 0; $attempt -lt 30 -and (Test-ProcessRunning $raceCandidatePid); $attempt++) { Start-Sleep -Milliseconds 100 }
  $raceCandidateStopped = $raceCandidatePid -gt 0 -and -not (Test-ProcessRunning $raceCandidatePid)
  $raceWinnerHealth = Get-BridgeHealth $racePort
  $raceWinnerHealthMatched = $raceWinnerPid -gt 0 -and $null -ne $raceWinnerHealth -and
    [int64]$raceWinnerHealth.pid -eq [int64]$raceWinnerPid -and
    [string]$raceWinnerHealth.buildId -eq $raceBuildId -and
    $raceWinnerPid -ne $raceCandidatePid
} finally {
  if ($raceCandidatePid -gt 0 -and (Test-ProcessRunning $raceCandidatePid)) {
    Stop-Process -Id $raceCandidatePid -Force -ErrorAction SilentlyContinue
  }
  if ($raceWinnerPid -gt 0 -and (Test-ProcessRunning $raceWinnerPid)) {
    Stop-Process -Id $raceWinnerPid -Force -ErrorAction SilentlyContinue
  }
  for ($attempt = 0; $attempt -lt 50 -and (Test-LocalPortInUse $racePort); $attempt++) { Start-Sleep -Milliseconds 100 }
  $raceListenerCleaned = -not (Test-LocalPortInUse $racePort)
  Remove-Item -LiteralPath $raceCandidatePidPath, $raceWinnerPidPath -Force -ErrorAction SilentlyContinue
  $racePidArtifactsCleaned = -not (Test-Path -LiteralPath $raceCandidatePidPath) -and
    -not (Test-Path -LiteralPath $raceWinnerPidPath)
}
Assert-True $raceRejected 'Windows installer candidate validation must reject a same-build listener owned by another PID'
Assert-True ($raceDiagnostic -match 'candidate PID') 'same-build port-winner rejection must identify the PID ownership mismatch'
Assert-True $raceCandidateStopped 'same-build port-winner rejection must terminate the spawned candidate process'
Assert-True $raceWinnerHealthMatched 'the race fixture must prove that a different PID won the port while reporting the expected build'
Assert-True $raceListenerCleaned 'same-build port-winner regression must clean the detached winner listener'
Assert-True $racePidArtifactsCleaned 'same-build port-winner regression must clean its PID artifacts'
Write-Host '[RelayBridge] Windows exact candidate-PID rejection passed.' -ForegroundColor DarkGray

# Stop-BridgeForCutover's WaitForExit-timeout and port-exhaustion branches, and
# its authenticated-shutdown-request failure, cannot be reached deterministically
# through a live process. Mock only the handle acquisition, health probe, port
# probe, shutdown request, and sleep - all in child scope - so the real function
# body still runs.
foreach ($pidCase in @(
  [pscustomobject]@{ capabilityAuth = $true },
  [pscustomobject]@{ capabilityAuth = $true; pid = $null },
  [pscustomobject]@{ capabilityAuth = $true; pid = 0 },
  [pscustomobject]@{ capabilityAuth = $true; pid = -1 },
  [pscustomobject]@{ capabilityAuth = $true; pid = 'not-a-pid' },
  [pscustomobject]@{ capabilityAuth = $true; pid = '2147483648' }
)) {
  & {
    $counter = @{ capture = 0; shutdown = 0; port = 0; sleep = 0 }
    function Get-BridgeHealth([int]$BridgePort, [int]$TimeoutSec = 2) { return $pidCase }
    function Test-Path { return $true }
    function Get-Content { return ('a' * 64) }
    function Get-BridgeShutdownProcessHandle([int]$ProcessId) { $counter.capture++; return $null }
    function Invoke-RestMethod { $counter.shutdown++ }
    function Test-LocalPortInUse([int]$BridgePort) { $counter.port++; return $false }
    function Start-Sleep([int]$Milliseconds) { $counter.sleep++ }
    $stoppedHealth = $null
    $errorMessage = ''
    try { Stop-BridgeForCutover 'C:\fake-runtime-root' 8787 ([ref]$stoppedHealth) }
    catch { $errorMessage = $_.Exception.Message }
    Assert-True ($errorMessage -match 'valid process identity') 'missing or invalid PID must fail before shutdown'
    Assert-True ($null -eq $stoppedHealth) 'invalid PID must not create restart evidence'
    Assert-True ($counter.capture -eq 0 -and $counter.shutdown -eq 0 -and $counter.port -eq 0 -and $counter.sleep -eq 0) 'invalid PID must not capture, stop, poll, or sleep'
  }
}
Write-Host '[RelayBridge] Stop-BridgeForCutover invalid-PID cases passed.' -ForegroundColor DarkGray

& {
  $counter = @{ captureIds = @(); shutdown = 0; port = 0; sleep = 0 }
  function Get-BridgeHealth([int]$BridgePort, [int]$TimeoutSec = 2) { return [pscustomobject]@{ capabilityAuth = $true; pid = 4242 } }
  function Test-Path { return $true }
  function Get-Content { return ('a' * 64) }
  function Get-BridgeShutdownProcessHandle([int]$ProcessId) { $counter.captureIds += $ProcessId; return $null }
  function Invoke-RestMethod { $counter.shutdown++ }
  function Test-LocalPortInUse([int]$BridgePort) { $counter.port++; return $false }
  function Start-Sleep([int]$Milliseconds) { $counter.sleep++ }
  $stoppedHealth = $null
  $errorMessage = ''
  try { Stop-BridgeForCutover 'C:\fake-runtime-root' 8787 ([ref]$stoppedHealth) }
  catch { $errorMessage = $_.Exception.Message }
  Assert-True ($errorMessage -match 'could not be pinned') 'an unpinnable process identity must fail before shutdown'
  Assert-True ($counter.captureIds.Count -eq 1 -and $counter.captureIds[0] -eq 4242) 'capture must target the exact reported PID once'
  Assert-True ($null -eq $stoppedHealth -and $counter.shutdown -eq 0 -and $counter.port -eq 0 -and $counter.sleep -eq 0) 'pin failure must not stop, poll, sleep, or record restart evidence'
}
Write-Host '[RelayBridge] Stop-BridgeForCutover unpinnable-PID case passed.' -ForegroundColor DarkGray

& {
  $counter = @{ order = @(); portChecks = 0; waitMilliseconds = @(); dispose = 0 }
  $health = [pscustomobject]@{ capabilityAuth = $true; pid = 4242 }
  function Get-BridgeHealth([int]$BridgePort, [int]$TimeoutSec = 2) { return $health }
  function Test-Path { return $true }
  function Get-Content { return ('a' * 64) }
  function Get-BridgeShutdownProcessHandle([int]$ProcessId) {
    $counter.order += 'capture'
    $process = [pscustomobject]@{ Counter = $counter }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
      param($Milliseconds)
      $this.Counter.order += 'wait'
      $this.Counter.waitMilliseconds += $Milliseconds
      return $true
    }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
      $this.Counter.order += 'dispose'
      $this.Counter.dispose++
    }
    return $process
  }
  function Invoke-RestMethod { $counter.order += 'shutdown'; return '{"ok":true}' }
  function Test-LocalPortInUse([int]$BridgePort) { $counter.order += 'port'; $counter.portChecks++; return ($counter.portChecks -gt 1) }
  function Start-Sleep([int]$Milliseconds) { throw 'closed listener must not sleep' }
  $stoppedHealth = $null
  $errorMessage = ''
  try { Stop-BridgeForCutover 'C:\fake-runtime-root' 8787 ([ref]$stoppedHealth) }
  catch { $errorMessage = $_.Exception.Message }
  Assert-True ($errorMessage -match 'occupied again after shutdown') 'reacquired listener must reject cutover'
  Assert-True (($counter.order -join ',') -eq 'capture,shutdown,port,wait,port,dispose') 'cutover must recheck port after waiting on the pinned process'
  Assert-True ($counter.portChecks -eq 2 -and $counter.waitMilliseconds.Count -eq 1 -and $counter.waitMilliseconds[0] -eq 10000 -and $counter.dispose -eq 1) 'reacquired port must wait and dispose exactly once'
  Assert-True ([object]::ReferenceEquals($health, $stoppedHealth)) 'reacquisition failure must preserve the original restart evidence'
}
Write-Host '[RelayBridge] Stop-BridgeForCutover reacquired-port case passed.' -ForegroundColor DarkGray

& {
  $counter = @{ order = @(); waitForExitCalls = 0; waitForExitMilliseconds = @(); disposeCalls = 0 }
  $health = [pscustomobject]@{ pid = 4242; capabilityAuth = $true }
  function Get-BridgeHealth([int]$BridgePort, [int]$TimeoutSec = 2) { $counter.order += 'health'; return $health }
  function Test-Path { return $true }
  function Get-Content { return ('a' * 64) }
  function Get-BridgeShutdownProcessHandle([int]$ProcessId) {
    $counter.order += 'capture'
    $process = [pscustomobject]@{ Counter = $counter }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
      param($Milliseconds)
      $this.Counter.order += 'wait'
      $this.Counter.waitForExitCalls++
      $this.Counter.waitForExitMilliseconds += $Milliseconds
      return $false
    }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
      $this.Counter.order += 'dispose'
      $this.Counter.disposeCalls++
    }
    return $process
  }
  function Invoke-RestMethod { $counter.order += 'shutdown'; return '{"ok":true}' }
  function Test-LocalPortInUse([int]$BridgePort) { $counter.order += 'portcheck'; return $false }
  function Start-Sleep([int]$Milliseconds) { throw 'must not sleep once the listener port has closed' }

  $stoppedHealth = $null
  $threw = $false
  $errorMessage = ''
  try { Stop-BridgeForCutover 'C:\fake-runtime-root' 8787 ([ref]$stoppedHealth) }
  catch { $threw = $true; $errorMessage = $_.Exception.Message }
  Assert-True $threw 'a WaitForExit timeout after authenticated shutdown must fail cutover'
  Assert-True ($errorMessage -match 'did not exit after authenticated shutdown') 'the WaitForExit-timeout failure must name the process that did not exit'
  Assert-True ($null -ne $stoppedHealth -and $stoppedHealth.pid -eq 4242) 'restart evidence must be preserved even when the exit wait times out'
  Assert-True ($counter.waitForExitCalls -eq 1 -and $counter.waitForExitMilliseconds[0] -eq 10000) 'WaitForExit must be called with the exact production timeout'
  Assert-True ($counter.disposeCalls -eq 1) 'the captured process handle must be disposed exactly once'
  $captureIndex = [Array]::IndexOf($counter.order, 'capture')
  $shutdownIndex = [Array]::IndexOf($counter.order, 'shutdown')
  $portIndex = [Array]::IndexOf($counter.order, 'portcheck')
  $waitIndex = [Array]::IndexOf($counter.order, 'wait')
  Assert-True ($captureIndex -ge 0 -and $captureIndex -lt $shutdownIndex) 'the process handle must be captured before authenticated shutdown is requested'
  Assert-True ($portIndex -ge 0 -and $portIndex -lt $waitIndex) 'the process exit wait must happen only after the listener port has closed'
}
Write-Host '[RelayBridge] Stop-BridgeForCutover WaitForExit-timeout case passed.' -ForegroundColor DarkGray

& {
  $counter = @{ portChecks = 0; sleeps = 0; sleepMilliseconds = @(); waitForExitCalls = 0; disposeCalls = 0 }
  $health = [pscustomobject]@{ pid = 4242; capabilityAuth = $true }
  function Get-BridgeHealth([int]$BridgePort, [int]$TimeoutSec = 2) { return $health }
  function Test-Path { return $true }
  function Get-Content { return ('a' * 64) }
  function Get-BridgeShutdownProcessHandle([int]$ProcessId) {
    $process = [pscustomobject]@{ Counter = $counter }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
      param($Milliseconds)
      $this.Counter.waitForExitCalls++
      return $true
    }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
      $this.Counter.disposeCalls++
    }
    return $process
  }
  function Invoke-RestMethod { return '{"ok":true}' }
  function Test-LocalPortInUse([int]$BridgePort) { $counter.portChecks++; return $true }
  function Start-Sleep([int]$Milliseconds) { $counter.sleeps++; $counter.sleepMilliseconds += $Milliseconds }

  $stoppedHealth = $null
  $threw = $false
  $errorMessage = ''
  try { Stop-BridgeForCutover 'C:\fake-runtime-root' 8787 ([ref]$stoppedHealth) }
  catch { $threw = $true; $errorMessage = $_.Exception.Message }
  Assert-True $threw 'exhausting every port-close attempt must fail cutover'
  Assert-True ($errorMessage -match 'did not stop before cutover') 'the port-exhaustion failure must name the stalled bridge'
  Assert-True ($null -ne $stoppedHealth -and $stoppedHealth.pid -eq 4242) 'restart evidence must be preserved even when the port never closes'
  Assert-True ($counter.portChecks -eq 100 -and $counter.sleeps -eq 100) 'port-close polling must stop at exactly the bounded attempt count'
  Assert-True (($counter.sleepMilliseconds | Where-Object { $_ -ne 100 }).Count -eq 0) 'every port-close poll must wait the exact production interval'
  Assert-True ($counter.waitForExitCalls -eq 0) 'the process exit wait must never run once port-close polling is exhausted'
  Assert-True ($counter.disposeCalls -eq 1) 'the captured process handle must be disposed exactly once'
}
Write-Host '[RelayBridge] Stop-BridgeForCutover port-exhaustion case passed.' -ForegroundColor DarkGray

& {
  $counter = @{ captured = $false; disposeCalls = 0; shutdownAttempted = $false; portChecked = $false; waitForExitCalls = 0 }
  $health = [pscustomobject]@{ pid = 4242; capabilityAuth = $true }
  function Get-BridgeHealth([int]$BridgePort, [int]$TimeoutSec = 2) { return $health }
  function Test-Path { return $true }
  function Get-Content { return ('a' * 64) }
  function Get-BridgeShutdownProcessHandle([int]$ProcessId) {
    $counter.captured = $true
    $process = [pscustomobject]@{ Counter = $counter }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
      param($Milliseconds)
      $this.Counter.waitForExitCalls++
      return $true
    }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
      $this.Counter.disposeCalls++
    }
    return $process
  }
  function Invoke-RestMethod { $counter.shutdownAttempted = $true; throw 'connection refused' }
  function Test-LocalPortInUse([int]$BridgePort) { $counter.portChecked = $true; return $false }
  function Start-Sleep([int]$Milliseconds) { throw 'a failed shutdown request must never wait or poll the port' }

  $stoppedHealth = $null
  $threw = $false
  $errorMessage = ''
  try { Stop-BridgeForCutover 'C:\fake-runtime-root' 8787 ([ref]$stoppedHealth) }
  catch { $threw = $true; $errorMessage = $_.Exception.Message }
  Assert-True $threw 'a failed authenticated shutdown request must fail cutover'
  Assert-True ($errorMessage -match 'Could not stop the RelayBridge') 'the shutdown-request failure must name the token/root mismatch cause'
  Assert-True ($counter.captured) 'the process handle must still be captured before the shutdown request is attempted'
  Assert-True ($counter.shutdownAttempted) 'the authenticated shutdown request must be attempted'
  Assert-True ($null -eq $stoppedHealth) 'no restart evidence may be recorded when the shutdown request itself fails'
  Assert-True (-not $counter.portChecked) 'a failed shutdown request must never poll the port'
  Assert-True ($counter.waitForExitCalls -eq 0) 'a failed shutdown request must never wait on the process'
  Assert-True ($counter.disposeCalls -eq 1) 'the captured process handle must be disposed exactly once'
}
Write-Host '[RelayBridge] Stop-BridgeForCutover authenticated-shutdown-failure case passed.' -ForegroundColor DarkGray

& {
  $counter = @{ waitForExitCalls = 0; waitForExitMilliseconds = @(); disposeCalls = 0; portChecks = 0 }
  $health = [pscustomobject]@{ pid = 4242; capabilityAuth = $true; buildId = '2.0.1+cccccccccccccccc' }
  function Get-BridgeHealth([int]$BridgePort, [int]$TimeoutSec = 2) { return $health }
  function Test-Path { return $true }
  function Get-Content { return ('a' * 64) }
  function Get-BridgeShutdownProcessHandle([int]$ProcessId) {
    $process = [pscustomobject]@{ Counter = $counter }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
      param($Milliseconds)
      $this.Counter.waitForExitCalls++
      $this.Counter.waitForExitMilliseconds += $Milliseconds
      return $true
    }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value {
      $this.Counter.disposeCalls++
    }
    return $process
  }
  function Invoke-RestMethod { return '{"ok":true}' }
  function Test-LocalPortInUse([int]$BridgePort) { $counter.portChecks++; return $false }
  function Start-Sleep([int]$Milliseconds) { throw 'must not sleep once the listener port has closed' }

  $stoppedHealth = $null
  $result = Stop-BridgeForCutover 'C:\fake-runtime-root' 8787 ([ref]$stoppedHealth)
  Assert-True ($null -ne $result -and $result.pid -eq 4242 -and $result.buildId -eq '2.0.1+cccccccccccccccc') 'a clean shutdown must return the pre-cutover health snapshot'
  Assert-True ($null -ne $stoppedHealth -and $stoppedHealth.pid -eq $result.pid -and $stoppedHealth.buildId -eq $result.buildId) 'StoppedHealth must record the identical snapshot returned to the caller'
  Assert-True ($counter.waitForExitCalls -eq 1 -and $counter.waitForExitMilliseconds[0] -eq 10000) 'WaitForExit must be called with the exact production timeout'
  Assert-True ($counter.disposeCalls -eq 1) 'the captured process handle must be disposed exactly once'
  Assert-True ($counter.portChecks -eq 2) 'a clean shutdown must confirm listener closure before and after process exit'
}
Write-Host '[RelayBridge] Stop-BridgeForCutover clean-exit success case passed.' -ForegroundColor DarkGray

if ($SafetyOnly) {
  if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host '[RelayBridge] Windows install safety-only tests passed.' -ForegroundColor Green
  return
}

New-Item -ItemType Directory -Path (Join-Path $installRoot 'data\receipts'), (Join-Path $installRoot 'config') -Force | Out-Null
try {
  # The new no-start migration cases need the real migration implementation but
  # not a second copy of the release's five-minute native suite. This canonical
  # source fixture still traverses the complete installer/stage/cutover path;
  # its locked test script is intentionally minimal.
  $migrationFixtureSource = Join-Path $testRoot 'migration-source-fixture'
  New-Item -ItemType Directory -Path (Join-Path $migrationFixtureSource 'lib'), (Join-Path $migrationFixtureSource 'tools') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot 'lib\github-tracker.js') -Destination (Join-Path $migrationFixtureSource 'lib\github-tracker.js')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'lib\platform.js') -Destination (Join-Path $migrationFixtureSource 'lib\platform.js')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'tools\migrate-github-registry.cjs') -Destination (Join-Path $migrationFixtureSource 'tools\migrate-github-registry.cjs')
  New-Item -ItemType Directory -Path (Join-Path $migrationFixtureSource 'config') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $repoRoot 'cli-config.json') -Destination (Join-Path $migrationFixtureSource 'cli-config.json')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'config\routing-policy.json') -Destination (Join-Path $migrationFixtureSource 'config\routing-policy.json')
  $migrationFixturePackage = @'
{"name":"relaybridge-migration-fixture","version":"2.0.1","private":true,"scripts":{"test":"node -e \"process.exit(0)\""}}
'@
  $migrationFixtureLock = @'
{"name":"relaybridge-migration-fixture","version":"2.0.1","lockfileVersion":3,"requires":true,"packages":{"":{"name":"relaybridge-migration-fixture","version":"2.0.1"}}}
'@
  [IO.File]::WriteAllText((Join-Path $migrationFixtureSource 'package.json'), ($migrationFixturePackage.Trim() + "`n"), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $migrationFixtureSource 'package-lock.json'), ($migrationFixtureLock.Trim() + "`n"), [Text.UTF8Encoding]::new($false))

  $legacyServer = @'
'use strict';
const fs = require('fs');
const http = require('http');
const token = fs.readFileSync('.bridge-token', 'utf8').trim();
const port = Number(process.env.PORT);
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Legacy identity shape: version but no buildId/buildIdentityReady. It
    // must still identify its exact process so rollback cannot accept an
    // unrelated listener that wins the port race.
    return res.end(JSON.stringify({ version: '2.0.0', capabilityAuth: true, pid: process.pid }));
  }
  if (req.method === 'POST' && req.url === '/api/admin/shutdown' && req.headers['x-relaybridge-token'] === token) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Close the listener first but deliberately retain the process/cwd briefly.
    // Windows cutover must wait for full process exit before renaming this tree.
    return res.end('{"ok":true}', () => server.close(() => setTimeout(() => process.exit(0), 750)));
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
      strip_env = @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'OPERATOR_CLAUDE_SECRET')
    }
    claude_fable = [ordered]@{
      safe = @('claude', '--permission-mode', 'plan', '--model', 'operator-fable-model', '--effort', 'max')
      dangerous = @('claude', '--model', 'operator-fable-model', '--effort', 'max', '--dangerously-skip-permissions')
      oneshot_safe = @('claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'plan', '--model', 'operator-fable-model', '--effort', 'max')
      oneshot_dangerous = @('claude', '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'operator-fable-model', '--effort', 'max', '--dangerously-skip-permissions')
      strip_env = @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY')
    }
    codex = [ordered]@{
      strip_env = @('OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL')
    }
    copilot = [ordered]@{
      credential_env = 'GH_CONFIG_DIR'
      login_command = @('copilot', '/login')
      strip_env = @('COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPERATOR_COPILOT_SECRET')
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
  $legacyGitHubRegistry = [ordered]@{
    repos = @([ordered]@{
      name = 'owner/repository'
      path = $installRoot
      autoCommit = $true
      autoPush = $false
      dryRun = $true
      trackingMode = 'checkpoint-on-branch'
    })
  }
  $legacyGitHubRegistryBytes = ($legacyGitHubRegistry | ConvertTo-Json -Depth 10) + "`n"
  $legacyGitHubRegistryPath = Join-Path $installRoot 'config\github-repos.json'
  [IO.File]::WriteAllText($legacyGitHubRegistryPath, $legacyGitHubRegistryBytes, [Text.UTF8Encoding]::new($false))

  # A helper rejection occurs after the old tree has been renamed and the new
  # release promoted. It must still restore every old byte and must never leave
  # a partially-created runtime registry behind.
  [IO.File]::WriteAllText($legacyGitHubRegistryPath, "{ definitely not JSON`n", [Text.UTF8Encoding]::new($false))
  $beforeMigrationFailure = Get-TreeFingerprint $installRoot
  $migrationFailed = Invoke-TestInstall -InstallSource $migrationFixtureSource
  Assert-True ($migrationFailed.ExitCode -ne 0) 'invalid legacy enrollment must fail the promoted installation'
  Assert-True ((Get-TreeFingerprint $installRoot) -eq $beforeMigrationFailure) 'migration rejection must roll the promoted tree back byte-for-byte'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $installRoot 'data\github-repos.json'))) 'migration rejection must not leave runtime enrollment behind'
  [IO.File]::WriteAllText($legacyGitHubRegistryPath, $legacyGitHubRegistryBytes, [Text.UTF8Encoding]::new($false))

  $before = Get-TreeFingerprint $installRoot
  $renameFailed = Invoke-TestInstall 'after-old-rename' -InstallSource $migrationFixtureSource
  Assert-True ($renameFailed.ExitCode -ne 0) 'the injected post-rename failure must fail the installer'
  Assert-True ($renameFailed.Diagnostic -match [Regex]::Escape('Injected installer failure at after-old-rename')) 'post-rename rollback regression must prove staging succeeded and reached its injected checkpoint'
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

  $failed = Invoke-TestInstall 'after-promote' -Port $legacyPort -InstallSource $migrationFixtureSource -FailRollbackCleanup
  Assert-True ($failed.ExitCode -ne 0) 'the injected post-promotion failure must fail the installer'
  Assert-True ($failed.Diagnostic -match [Regex]::Escape('Injected installer failure at after-promote')) 'post-promotion rollback regression must prove staging and promotion reached the injected checkpoint'
  Assert-True ($failed.Diagnostic -match 'failed release cleanup deferred: Injected rollback cleanup failure') 'rollback diagnostics must retain a non-fatal failed-release cleanup warning'
  Assert-True ((Get-TreeFingerprint $installRoot) -eq $before) 'automatic rollback must restore retained release/runtime files byte-for-byte'
  try {
    $restoredHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$legacyPort/api/health" -TimeoutSec 3 -UseBasicParsing
  } catch {
    throw "rollback did not restore the legacy health endpoint. Installer diagnostics:`n$($failed.Diagnostic)"
  }
  Assert-True ($restoredHealth.version -eq '2.0.0') 'rollback must restart a pre-buildId RelayBridge by its legacy version'
  $failedRecoveryRoots = @(Get-ChildItem -LiteralPath $testRoot -Directory | Where-Object { $_.Name -like 'RelayBridge.failed.*' })
  Assert-True ($failedRecoveryRoots.Count -eq 1) 'a failed-release cleanup warning must preserve exactly one quarantined recovery tree'
  Remove-Item -LiteralPath $failedRecoveryRoots[0].FullName -Recurse -Force
  $legacyToken = (Get-Content -LiteralPath (Join-Path $installRoot '.bridge-token') -Raw).Trim()
  Invoke-RestMethod -Uri "http://127.0.0.1:$legacyPort/api/admin/shutdown" -Method Post -Headers @{ 'X-RelayBridge-Token' = $legacyToken } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 -UseBasicParsing | Out-Null
  for ($attempt = 0; $attempt -lt 50 -and (Get-NetTCPConnection -State Listen -LocalPort $legacyPort -ErrorAction SilentlyContinue); $attempt++) { Start-Sleep -Milliseconds 100 }
  Assert-True (-not (Get-NetTCPConnection -State Listen -LocalPort $legacyPort -ErrorAction SilentlyContinue)) 'restored legacy bridge must shut down cleanly after rollback verification'
  $legacyPort = 0

  $success = Invoke-TestInstall -Start
  if ($success.ExitCode -ne 0) {
    throw "Installer success case failed with exit code $($success.ExitCode). $($success.Diagnostic)"
  }
  $startedPort = $success.Port
  Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'server.js') -PathType Leaf) 'new server.js must be promoted'
  Assert-True (Test-Path -LiteralPath (Join-Path $installRoot 'relaybridge.cmd') -PathType Leaf) 'Windows CLI shim must be promoted'
  # WSL may launch this harness from a UNC checkout. cmd.exe cannot use that
  # cwd, while the promoted application intentionally lives on native Windows.
  Push-Location -LiteralPath $installRoot
  try {
    $cliHelp = & (Join-Path $installRoot 'relaybridge.cmd') --help 2>&1 | Out-String
    $cliHelpExitCode = $LASTEXITCODE
  } finally { Pop-Location }
  Assert-True ($cliHelpExitCode -eq 0) 'promoted Windows CLI shim must execute successfully'
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
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $installRoot 'config\github-repos.json'))) 'legacy machine-specific enrollment must not be copied back into release config'
  $migratedGitHubRegistryPath = Join-Path $installRoot 'data\github-repos.json'
  Assert-True (Test-Path -LiteralPath $migratedGitHubRegistryPath -PathType Leaf) 'legacy enrollment must migrate into preserved runtime data'
  $migratedGitHubRegistry = [IO.File]::ReadAllText($migratedGitHubRegistryPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  Assert-True ($migratedGitHubRegistry.repos[0].name -eq 'owner/repository') 'migration must read the old enrollment from backupRoot after InstallDir was renamed'
  Assert-True ($migratedGitHubRegistry.repos[0].path -eq $installRoot) 'migration must preserve the native checkout path'

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
  $shippedConfig = [IO.File]::ReadAllText((Join-Path $repoRoot 'cli-config.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  $managedProviderArgs = $shippedConfig._config_merge.managed_provider_args
  Assert-True ($managedProviderArgs.PSObject.Properties.Name.Count -gt 0) 'shipped managed_provider_args must declare at least one managed provider so this assertion cannot vacuously pass'
  $managedMappingCount = 0
  foreach ($providerSpec in $managedProviderArgs.PSObject.Properties) {
    $providerName = $providerSpec.Name
    foreach ($slotName in @($providerSpec.Value.slots)) {
      foreach ($argSpec in @($providerSpec.Value.args)) {
        $flag = [string]$argSpec.flag
        $valueCount = [int]$argSpec.value_count
        $shippedSlotArgs = @($shippedConfig.$providerName.$slotName)
        $shippedFlagIndex = [Array]::IndexOf($shippedSlotArgs, $flag)
        Assert-True ($shippedFlagIndex -ge 0) "shipped $providerName.$slotName must declare managed flag $flag"
        $expectedValues = @($shippedSlotArgs[($shippedFlagIndex + 1)..($shippedFlagIndex + $valueCount)])
        $mergedSlotArgs = @($merged.$providerName.$slotName)
        $mergedFlagIndex = [Array]::IndexOf($mergedSlotArgs, $flag)
        Assert-True ($mergedFlagIndex -ge 0) "$providerName.$slotName must retain managed flag $flag after migration"
        $actualValues = @($mergedSlotArgs[($mergedFlagIndex + 1)..($mergedFlagIndex + $valueCount)])
        Assert-True ((($actualValues -join ',') -ceq ($expectedValues -join ','))) "$providerName.$slotName must migrate managed flag $flag to this release's exact shipped value"
        $managedMappingCount++
      }
    }
  }
  Assert-True ($managedMappingCount -ge 6) 'derived managed provider-argument mappings must cover every declared managed slot, not vacuously pass on an empty fixture'
  foreach ($unmanagedSlotName in @('dangerous', 'oneshot_dangerous')) {
    $unmanagedSlotArgs = @($merged.claude_fable.$unmanagedSlotName)
    $unmanagedEffortIndex = [Array]::IndexOf($unmanagedSlotArgs, '--effort')
    Assert-True ($unmanagedEffortIndex -ge 0 -and $unmanagedSlotArgs[$unmanagedEffortIndex + 1] -eq 'max') "claude_fable.$unmanagedSlotName is unmanaged and must retain the installed fixture effort value"
    Assert-True (Test-ExactJsonStringArray @($merged.claude_fable.$unmanagedSlotName) @($operatorConfig.claude_fable.$unmanagedSlotName)) "undeclared claude_fable.$unmanagedSlotName operator arguments must remain byte-exact"
  }
  Assert-True ($merged.claude.safe[[Array]::IndexOf(@($merged.claude.safe), '--model') + 1] -eq 'operator-claude-model') 'managed-argument migration must preserve an operator model choice'
  Assert-True (@($merged.claude.safe) -contains '--operator-flag') 'managed-argument migration must preserve unrelated operator flags'
  Assert-True ($merged.claude_fable.safe[[Array]::IndexOf(@($merged.claude_fable.safe), '--model') + 1] -eq 'operator-fable-model') 'managed-argument migration must preserve the Fable model choice'
  Assert-True ($merged.cursor.tags[0] -eq 'custom-routing') 'operator routing tags must be preserved'
  Assert-True ($merged.cursor.probe_expect -eq 'Logged in as') 'missing release fields must be added to existing providers'
  Assert-True ($merged.copilot.credential_env -ceq 'COPILOT_HOME') 'the installed retired Copilot environment variable must migrate end-to-end'
  Assert-True ((Test-ExactJsonStringArray $merged.copilot.credential_markers @('config.json'))) 'the installed retired Copilot marker must migrate end-to-end'
  Assert-True ((Test-ExactJsonStringArray $merged.copilot.login_command @('copilot', 'login'))) 'the installed retired Copilot login command must migrate end-to-end'
  Assert-True ($merged.copilot.linked_accounts_supported -eq $false) 'upgrades must disable unsafe profile-only Copilot account pooling'
  foreach ($providerName in @('claude', 'claude_fable', 'codex', 'copilot')) {
    foreach ($requiredName in @($shippedConfig.$providerName.strip_env)) {
      Assert-True (@($merged.$providerName.strip_env) -contains $requiredName) "$providerName must gain required identity exclusion $requiredName on upgrade"
    }
  }
  Assert-True (@($merged.claude.strip_env) -contains 'OPERATOR_CLAUDE_SECRET') 'required exclusions must preserve a Claude operator extra'
  Assert-True (@($merged.copilot.strip_env) -contains 'OPERATOR_COPILOT_SECRET') 'required exclusions must preserve a Copilot operator extra'
  Assert-True ($merged.custom_provider.label -eq 'Private Operator Provider') 'unknown operator providers must be preserved'
  $routing = [IO.File]::ReadAllText((Join-Path $installRoot 'config\routing-policy.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  Assert-True ($routing.operatorNote -eq 'preserve me') 'operator routing-policy fields must be preserved'
  Assert-True ($routing.taskPriorities.general[0] -eq 'custom_provider') 'operator routing priority must win'

  $build = [IO.File]::ReadAllText((Join-Path $installRoot 'build-info.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  Assert-True ([string]$build.buildId -match $releaseBuildIdPattern) 'installed release must have an exact code-hash build identity'
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($success.Port)/api/health" -TimeoutSec 3 -UseBasicParsing
  Assert-True ([string]$health.buildId -eq [string]$build.buildId) 'promoted server health must report the exact staged build identity'
  Assert-True ($health.buildIdentityReady -eq $true) 'promoted server must report a ready exact build identity before install succeeds'
  $token = (Get-Content -LiteralPath (Join-Path $installRoot '.bridge-token') -Raw).Trim()
  Invoke-RestMethod -Uri "http://127.0.0.1:$($success.Port)/api/admin/shutdown" -Method Post -Headers @{ 'X-RelayBridge-Token' = $token } -ContentType 'application/json' -Body '{}' -TimeoutSec 3 -UseBasicParsing | Out-Null
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    try { Invoke-RestMethod -Uri "http://127.0.0.1:$($success.Port)/api/health" -TimeoutSec 1 -UseBasicParsing | Out-Null }
    catch { break }
    Start-Sleep -Milliseconds 100
  }
  $startedPort = 0

  # Exercise the distinct-root migration contract end to end. Runtime files
  # move into the new install, while the legacy config remains at the unchanged
  # MigrateFrom path long enough for the post-promotion helper to read it.
  $migrateFromRoot = Join-Path $testRoot 'LegacySource'
  $migrateTargetRoot = Join-Path $testRoot 'MigratedRelayBridge'
  New-Item -ItemType Directory -Path (Join-Path $migrateFromRoot 'config'), (Join-Path $migrateFromRoot 'data\receipts') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $migrateFromRoot 'old-code.txt'), "old source remains`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $migrateFromRoot '.bridge-token'), (('b' * 64) + "`n"), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $migrateFromRoot 'data\receipts\from-old.jsonl'), "{`"receiptId`":`"migrated`"}`n", [Text.UTF8Encoding]::new($false))
  $migrateFromRegistry = [ordered]@{
    repos = @([ordered]@{
      name = 'owner/migrate-from'
      path = $migrateFromRoot
      autoPush = $false
      trackingMode = 'checkpoint-on-branch'
    })
  }
  $migrateFromRegistryBytes = ($migrateFromRegistry | ConvertTo-Json -Depth 10) + "`n"
  $migrateFromRegistryPath = Join-Path $migrateFromRoot 'config\github-repos.json'
  [IO.File]::WriteAllText($migrateFromRegistryPath, $migrateFromRegistryBytes, [Text.UTF8Encoding]::new($false))

  $migrateFromResult = Invoke-TestInstall -TargetInstallDir $migrateTargetRoot -MigrationSource $migrateFromRoot -InstallSource $migrationFixtureSource
  if ($migrateFromResult.ExitCode -ne 0) {
    throw "MigrateFrom installer case failed with exit code $($migrateFromResult.ExitCode). $($migrateFromResult.Diagnostic)"
  }
  Assert-True (Test-Path -LiteralPath (Join-Path $migrateFromRoot 'old-code.txt') -PathType Leaf) 'MigrateFrom must leave the old code tree in place'
  Assert-True ([IO.File]::ReadAllText($migrateFromRegistryPath, [Text.UTF8Encoding]::new($false)) -eq $migrateFromRegistryBytes) 'MigrateFrom must read legacy enrollment from its unchanged source path without modifying it'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $migrateFromRoot '.bridge-token'))) 'MigrateFrom must move the capability token out of the old root'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $migrateFromRoot 'data'))) 'MigrateFrom must move runtime data out of the old root'
  Assert-True ((Get-Content -LiteralPath (Join-Path $migrateTargetRoot '.bridge-token') -Raw).Trim() -eq ('b' * 64)) 'MigrateFrom must preserve capability-token bytes in the new root'
  Assert-True (Test-Path -LiteralPath (Join-Path $migrateTargetRoot 'data\receipts\from-old.jsonl') -PathType Leaf) 'MigrateFrom must preserve receipt data in the new root'
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $migrateTargetRoot 'config\github-repos.json'))) 'MigrateFrom must not copy machine enrollment back into release config'
  $migrateFromRuntimeRegistry = [IO.File]::ReadAllText((Join-Path $migrateTargetRoot 'data\github-repos.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  Assert-True ($migrateFromRuntimeRegistry.repos[0].name -eq 'owner/migrate-from') 'MigrateFrom must migrate unchanged-source enrollment into target runtime state'

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

[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$RepositoryRoot)
# Native PowerShell 5.1 matching and production cutover-order regressions.
# No process census, installer execution, files under the repository, or provider calls.
$ErrorActionPreference = 'Stop'
$installer = Join-Path $RepositoryRoot 'install.ps1'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$null, [ref]$null)
$names = @('Get-NormalizedPath', 'Test-SamePath', 'Split-WindowsCommandLine', 'ConvertTo-InstallMcpHolder', 'Get-InstallMcpHolders')
$definitions = @{}
foreach ($function in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  if ($names -contains $function.Name) { $definitions[$function.Name] = $function.Extent.Text }
}
foreach ($name in $names) { if (-not $definitions.ContainsKey($name)) { throw "Missing production helper: $name" } }
. ([scriptblock]::Create(($names | ForEach-Object { $definitions[$_] }) -join "`n"))
$failures = New-Object 'System.Collections.Generic.List[string]'
$passed = 0
function Check([string]$Label, [scriptblock]$Action) {
  try { & $Action; $script:passed++; Write-Host ('PASS ' + $Label) }
  catch { $script:failures.Add($Label + ': ' + $_.Exception.Message); Write-Host ('FAIL ' + $Label + ': ' + $_.Exception.Message) }
}
function Expect([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Row([string]$CommandLine, [string]$Name = 'node.exe') {
  return [pscustomobject]@{ Name = $Name; ProcessId = 12345; ParentProcessId = 123;
    CreationDate = '2026-09-11T00:00:00Z'; ExecutablePath = $null; CommandLine = $CommandLine }
}
$root = 'C:\RelayBridge match fixture'
$script = $root + '\mcp\server.mjs'
$previousCwd = [Environment]::CurrentDirectory
try {
  [Environment]::CurrentDirectory = 'C:\'
  Check 'quoted absolute adapter is matched without privileged ExecutablePath' {
    $match = ConvertTo-InstallMcpHolder $root (Row ('"C:\Program Files\nodejs\node.exe" "' + $script + '"'))
    Expect ($match.pid -eq 12345 -and $match.role -eq 'mcp_adapter') 'exact adapter should match'
  }
  Check 'absolute launcher and case/dot normalization match' {
    $match = ConvertTo-InstallMcpHolder $root (Row 'node.exe "c:\relaybridge MATCH fixture\mcp\..\mcp\launcher.mjs"')
    Expect ($match.role -eq 'mcp_launcher') 'exact normalized launcher should match'
  }
  $negative = [ordered]@{
    'ordinary relative script is ignored' = 'node.exe mcp\server.mjs';
    'root-relative script is ignored' = 'node.exe "\RelayBridge match fixture\mcp\server.mjs"';
    'drive-relative script is ignored' = 'node.exe "C:RelayBridge match fixture\mcp\server.mjs"';
    'sibling install is ignored' = 'node.exe "C:\RelayBridge match fixture-copy\mcp\server.mjs"';
    'backup extension is ignored' = 'node.exe "C:\RelayBridge match fixture\mcp\server.mjs.bak"';
    'target as later argument is ignored' = 'node.exe unrelated.js "C:\RelayBridge match fixture\mcp\server.mjs"';
    'target in eval is ignored' = 'node.exe -e "C:\RelayBridge match fixture\mcp\server.mjs"';
    'empty command line is ignored' = ''
  }
  foreach ($label in $negative.Keys) {
    $line = $negative[$label]
    Check $label { Expect ($null -eq (ConvertTo-InstallMcpHolder $root (Row $line))) 'must not infer another process cwd from installer cwd' }
  }
  Check 'non-node process cannot become a holder through arguments' {
    Expect ($null -eq (ConvertTo-InstallMcpHolder $root (Row ('powershell.exe "' + $script + '"') 'powershell.exe'))) 'must ignore non-node process'
  }
  Check 'recognized exact script with argument-limit overflow is not silently called absent' {
    $failed = $false; $match = $null
    try { $match = ConvertTo-InstallMcpHolder $root (Row ('node.exe "' + $script + '"' + (' a' * 256))) } catch { $failed = $true }
    Expect ($failed -or $null -ne $match) 'parser bound should produce explicit unavailable or parse bounded first two arguments; not return empty argv'
  }
} finally { [Environment]::CurrentDirectory = $previousCwd }


Check 'holder census bounds diagnostics and deduplicates exact PIDs' {
  function Get-InstallMcpProcessRows {
    foreach ($index in 1..100) {
      $row = Row ('node.exe "' + $script + '"'); $row.ProcessId = 20000 + $index
      $row; $row
    }
  }
  $evidence = Get-InstallMcpHolders $root
  Expect ($evidence.holderCount -eq 100 -and $evidence.holders.Count -eq 32 -and $evidence.truncated) 'bounded census counts or deduplication changed'
}
Check 'failed census returns unavailable, never a clear result' {
  function Get-InstallMcpProcessRows { throw 'fixture native inventory unavailable' }
  $failure = ''
  try { $null = Get-InstallMcpHolders $root } catch { $failure = $_.Exception.Message }
  Expect ($failure -match 'install_preflight_unavailable') 'inventory failure must not become zero holders'
}

# Execute the shipped core if(runtimeSource) block, replacing only its I/O helpers.
$blocks = @($ast.FindAll({ param($node)
  $node -is [System.Management.Automation.Language.IfStatementAst] -and $node.Extent.Text.StartsWith('if ($runtimeSource) {')
}, $true))
if ($blocks.Count -ne 1) { throw 'Expected exactly one core runtimeSource cutover block' }
$cutoverBlock = [scriptblock]::Create($blocks[0].Extent.Text)
function Run-CutoverFixture([string]$BlockAt) {
  $runtimeSource = 'C:\fixture'; $InstallDir = $runtimeSource; $stageRoot = 'C:\fixture-stage'; $Port = 0
  $hadExistingInstall = $true; $oldHealth = $null; $movedRuntime = @(); $preserveRecoveryArtifacts = $false
  $calls = New-Object 'System.Collections.Generic.List[string]'
  function Assert-InstallRootMcpAvailable([string]$InstallRoot, [string]$Phase) {
    $calls.Add('probe:' + $Phase)
    if ($Phase -eq $BlockAt) { throw 'install_root_locked: fixture holder appeared' }
  }
  function Stop-BridgeForCutover([string]$RuntimeRoot, [int]$BridgePort, [ref]$StoppedHealth) {
    $calls.Add('shutdown'); $health = [pscustomobject]@{ pid = 42; buildId = 'old-fixture-build' }
    $StoppedHealth.Value = $health; return $health
  }
  function Merge-OperatorConfiguration { $calls.Add('merge') }
  function Move-PreservedRuntime { $calls.Add('move'); return @('.bridge-token', 'data') }
  function Test-LocalPortInUse { throw 'unexpected port check' }
  $caught = ''
  try { . $cutoverBlock } catch { $caught = $_.Exception.Message }
  return [pscustomobject]@{ calls = @($calls); caught = $caught; oldHealth = $oldHealth;
    moved = @($movedRuntime); preserveRecoveryArtifacts = $preserveRecoveryArtifacts }
}
Check 'staging race blocks before stopping old service or moving state' {
  $result = Run-CutoverFixture 'before_shutdown'
  Expect (($result.calls -join ',') -eq 'probe:before_shutdown') 'staging holder must block shutdown and movement'
  Expect ($result.caught -match 'install_root_locked') 'staging holder surfaces typed failure'
  Expect ($null -eq $result.oldHealth -and $result.moved.Count -eq 0) 'untouched old service does not trigger rollback restart'
}
Check 'shutdown race preserves old-health rollback evidence and blocks runtime movement' {
  $result = Run-CutoverFixture 'before_runtime_move'
  Expect (($result.calls -join ',') -eq 'probe:before_shutdown,shutdown,probe:before_runtime_move') 'shutdown holder must block move'
  Expect ($result.oldHealth.pid -eq 42 -and $result.oldHealth.buildId -eq 'old-fixture-build') 'rollback must retain exact old-health evidence'
  Expect ($result.moved.Count -eq 0 -and -not $result.preserveRecoveryArtifacts) 'no authority state moved yet'
}
Check 'clean cutover checks twice then merges and moves in production order' {
  $result = Run-CutoverFixture ''
  Expect (($result.calls -join ',') -eq 'probe:before_shutdown,shutdown,probe:before_runtime_move,merge,move') 'successful ordering changed'
  Expect ($result.moved.Count -eq 2 -and $result.preserveRecoveryArtifacts) 'successful movement activates recovery preservation'
}
Write-Host ('RESULT passed=' + $passed + ' failed=' + $failures.Count)
if ($failures.Count) { exit 1 }

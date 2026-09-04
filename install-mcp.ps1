[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9_-]+$')]
  [string]$Name = 'relaybridge',

  [ValidatePattern('^http://127\.0\.0\.1(:[0-9]{1,5})?$')]
  [string]$BridgeUrl = 'http://127.0.0.1:8787',

  [switch]$SkipCodex,
  [switch]$SkipClaude,

  [string[]]$LegacyNames = @('ps_bridge', 'ps-bridge')
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$mcpServer = Join-Path $bridgeRoot 'mcp\server.mjs'
$tokenFile = Join-Path $bridgeRoot '.bridge-token'
$timeoutPolicyPath = Join-Path $bridgeRoot 'config\timeout-policy.json'
$buildInfoTool = Join-Path $bridgeRoot 'tools\prepare-build-info.cjs'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$codexConfigPath = Join-Path $env:USERPROFILE '.codex\config.toml'
$claudeConfigPath = Join-Path $env:USERPROFILE '.claude.json'
$registrationLockTimeoutMilliseconds = 30000

foreach ($legacyName in $LegacyNames) {
  if ($legacyName -notmatch '^[A-Za-z0-9_-]+$') { throw "Invalid legacy MCP registration name: $legacyName" }
}

function Get-ConfigSnapshot([string]$Path) {
  $exists = Test-Path -LiteralPath $Path -PathType Leaf
  [pscustomobject]@{
    Path = $Path
    Exists = $exists
    Bytes = if ($exists) { [IO.File]::ReadAllBytes($Path) } else { $null }
  }
}

function Restore-ConfigSnapshot($Snapshot) {
  if ($Snapshot.Exists) {
    [IO.File]::WriteAllBytes($Snapshot.Path, $Snapshot.Bytes)
  } elseif (Test-Path -LiteralPath $Snapshot.Path -PathType Leaf) {
    Remove-Item -LiteralPath $Snapshot.Path -Force
  }
}

function Get-CurrentWindowsUserSid {
  $identity = (& whoami.exe /user /fo csv /nh 2>$null | Out-String)
  $match = [regex]::Match($identity, 'S-[0-9]+(?:-[0-9]+)+')
  if (-not $match.Success) { throw 'Could not resolve the current Windows user SID for local-state ACL hardening.' }
  return $match.Value
}

function New-McpRegistrationMutexSecurity([string]$Sid) {
  $security = New-Object System.Security.AccessControl.MutexSecurity
  $security.SetAccessRuleProtection($true, $false)
  $currentUser = New-Object System.Security.Principal.SecurityIdentifier($Sid)
  foreach ($principal in @(
    $currentUser,
    (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')),
    (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'))
  )) {
    $rule = New-Object System.Security.AccessControl.MutexAccessRule(
      $principal,
      [System.Security.AccessControl.MutexRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    $security.AddAccessRule($rule)
  }
  $security.SetOwner($currentUser)
  return $security
}

function Assert-McpRegistrationMutexSecurity($Mutex, [string]$ExpectedSid) {
  try {
    $security = $Mutex.GetAccessControl()
    $owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    $rules = @($security.GetAccessRules(
      $true,
      $true,
      [System.Security.Principal.SecurityIdentifier]
    ))
  } catch {
    throw 'MCP registration mutex security descriptor could not be verified.'
  }

  $allowedSids = @($ExpectedSid, 'S-1-5-18', 'S-1-5-32-544')
  if ($owner -ne $ExpectedSid -or -not $security.AreAccessRulesProtected -or
      -not $security.AreAccessRulesCanonical) {
    throw 'MCP registration mutex security descriptor is not trusted.'
  }
  $seenSids = @{}
  foreach ($rule in $rules) {
    $ruleSid = $rule.IdentityReference.Value
    if ($allowedSids -notcontains $ruleSid -or $rule.IsInherited -or
        $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        [int64]$rule.MutexRights -ne [int64][System.Security.AccessControl.MutexRights]::FullControl) {
      throw 'MCP registration mutex security descriptor is not trusted.'
    }
    $seenSids[$ruleSid] = $true
  }
  foreach ($requiredSid in $allowedSids) {
    if (-not $seenSids.ContainsKey($requiredSid)) {
      throw 'MCP registration mutex security descriptor is not trusted.'
    }
  }
}

function Enter-McpRegistrationLock([int]$TimeoutMilliseconds) {
  if ($TimeoutMilliseconds -lt 1) { throw 'The MCP registration-lock timeout must be positive.' }
  $sid = Get-CurrentWindowsUserSid
  # A SID-named Global kernel object gives every checkout and Windows session
  # for this OS user exactly one namespace. No environment or CLI override can
  # accidentally split transactions that mutate the same user-global clients.
  $mutexName = "Global\RelayBridge-McpInstall-$sid"
  $mutexSecurity = New-McpRegistrationMutexSecurity $sid
  $createdNew = $false
  $mutex = $null
  $owned = $false
  $abandoned = $false
  try {
    $mutex = [System.Threading.Mutex]::new($false, $mutexName, [ref]$createdNew, $mutexSecurity)
    # Constructor security is applied only when the object is new. An existing
    # object is accepted only after its live descriptor proves the same owner,
    # protected DACL, principals, and rights we require for a new mutex.
    Assert-McpRegistrationMutexSecurity $mutex $sid
    try { $owned = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $owned = $true; $abandoned = $true }
    if (-not $owned) {
      Write-Host '[RelayBridge] Another MCP registration is active; waiting for its transaction lock...' -ForegroundColor Yellow
      try { $owned = $mutex.WaitOne($TimeoutMilliseconds) }
      catch [System.Threading.AbandonedMutexException] { $owned = $true; $abandoned = $true }
    }
    if (-not $owned) {
      throw "Timed out after $TimeoutMilliseconds ms waiting for the active MCP registration transaction lock."
    }
    return [pscustomobject]@{ Mutex = $mutex; Name = $mutexName; Abandoned = $abandoned }
  } catch {
    if ($null -ne $mutex) {
      if ($owned) {
        try { $mutex.ReleaseMutex() } catch { }
      }
      $mutex.Dispose()
    }
    throw
  }
}

function Exit-McpRegistrationLock($Lock) {
  if ($null -ne $Lock -and $null -ne $Lock.Mutex) {
    # Release only the exact kernel object successfully acquired above. An
    # abandoned owner is recovered by WaitOne; there is no path to delete.
    try { $Lock.Mutex.ReleaseMutex() }
    finally { $Lock.Mutex.Dispose() }
  }
}

function Protect-CapabilityToken([string]$Path) {
  if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) { return }
  $sid = Get-CurrentWindowsUserSid
  & icacls.exe $Path /inheritance:r /grant:r "*${sid}:(F)" /grant:r '*S-1-5-18:(F)' /grant:r '*S-1-5-32-544:(F)' *> $null
  if ($LASTEXITCODE -ne 0) { throw "Could not harden the capability-token ACL: $Path" }
  $aclText = (& icacls.exe $Path 2>$null | Out-String)
  if ($LASTEXITCODE -ne 0 -or $aclText -match '\(I\)') { throw "Capability-token ACL verification failed: $Path" }
}

function Test-LegacyRelayBridgeRegistration([ValidateSet('codex', 'claude')] [string]$Client, [string]$LegacyName) {
  if (-not $LegacyName -or $LegacyName -eq $Name) { return $false }
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    if ($Client -eq 'codex') { $output = (& codex mcp get $LegacyName --json 2>$null | Out-String) }
    else { $output = (& claude mcp get $LegacyName 2>$null | Out-String) }
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $savedErrorActionPreference }
  return $exitCode -eq 0 -and $output -match '(?i)mcp[\\/]+server\.mjs'
}

if (-not (Test-Path -LiteralPath $mcpServer -PathType Leaf)) {
  throw "MCP server not found: $mcpServer"
}
if (-not (Test-Path -LiteralPath $timeoutPolicyPath -PathType Leaf)) {
  throw "Timeout policy not found: $timeoutPolicyPath"
}
if (-not (Test-Path -LiteralPath $buildInfoTool -PathType Leaf)) {
  throw "Build identity tool not found: $buildInfoTool"
}
$timeoutPolicy = [IO.File]::ReadAllText($timeoutPolicyPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$mcpToolTimeoutSec = [int][Math]::Ceiling((
  [double]$timeoutPolicy.oneShotMaxMs +
  [double]$timeoutPolicy.transportGraceMs +
  [double]$timeoutPolicy.mcpHostGraceMs
) / 1000)
if ($mcpToolTimeoutSec -lt 1) { throw "Invalid timeout policy: $timeoutPolicyPath" }
$registrationLock = $null
try {
$registrationLock = Enter-McpRegistrationLock $registrationLockTimeoutMilliseconds
$tokenCreated = $false
$configurationSnapshots = @()
if (-not $SkipCodex) { $configurationSnapshots += Get-ConfigSnapshot $codexConfigPath }
if (-not $SkipClaude) { $configurationSnapshots += Get-ConfigSnapshot $claudeConfigPath }

try {
$tokenExists = Test-Path -LiteralPath $tokenFile -PathType Leaf
if (-not $tokenExists) {
  Write-Host '[RelayBridge] Creating the local capability token...' -ForegroundColor Cyan
  # Mark ownership before the first write so even a partial WriteAllText
  # failure is removed by the catch below.
  $tokenCreated = $true
  $tokenBytes = New-Object byte[] 32
  $tokenRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $tokenRng.GetBytes($tokenBytes) } finally { $tokenRng.Dispose() }
  $token = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
  [IO.File]::WriteAllText($tokenFile, "$token`n", [Text.UTF8Encoding]::new($false))
} else {
  $existingToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
  if ($existingToken -notmatch '^[A-Fa-f0-9]{64}$') { throw "Existing RelayBridge capability token is invalid: $tokenFile" }
}
Protect-CapabilityToken $tokenFile

# build-info.json is deterministic generated state and is published atomically.
# Do not include it in configuration rollback: restoring an old snapshot could
# clobber a newer manifest concurrently prepared by another launcher.
$preparedBuildText = (& $nodePath $buildInfoTool $bridgeRoot | Out-String).Trim()
$preparedBuildExitCode = $LASTEXITCODE
if ($preparedBuildExitCode -ne 0 -or $preparedBuildText -notmatch '^[A-Za-z0-9._+-]{1,128}$') {
  throw 'Could not prepare or validate an exact RelayBridge build identity; MCP registration was not changed.'
}
Write-Host "[RelayBridge] Exact build identity ready: $preparedBuildText" -ForegroundColor Green

if (-not $SkipCodex) {
  if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    throw 'Codex CLI is not installed or is not on PATH.'
  }
  & codex mcp remove $Name 2>$null | Out-Null
  & codex mcp add $Name `
    --env "RELAYBRIDGE_URL=$BridgeUrl" `
    --env "RELAYBRIDGE_TOKEN_FILE=$tokenFile" `
    -- $nodePath $mcpServer
  if ($LASTEXITCODE -ne 0) { throw "codex mcp add failed for $Name" }

  $codexAddedText = (& codex mcp get $Name --json 2>$null | Out-String)
  $codexAddedExitCode = $LASTEXITCODE
  try { $codexAdded = $codexAddedText | ConvertFrom-Json }
  catch { throw "Codex canonical MCP '$Name' returned invalid verification JSON." }
  $codexTransport = if ($codexAdded.PSObject.Properties['transport']) { $codexAdded.transport } else { $codexAdded }
  $codexServerVerified = @($codexTransport.args | Where-Object {
    try { [string]::Equals([IO.Path]::GetFullPath([string]$_), [IO.Path]::GetFullPath($mcpServer), [StringComparison]::OrdinalIgnoreCase) }
    catch { $false }
  }).Count -gt 0
  if ($codexAddedExitCode -ne 0 -or -not $codexServerVerified -or
      [string]$codexTransport.env.RELAYBRIDGE_URL -ne $BridgeUrl -or
      -not [string]::Equals([string]$codexTransport.env.RELAYBRIDGE_TOKEN_FILE, $tokenFile, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Codex canonical MCP '$Name' did not verify after registration."
  }

  $codexConfig = $codexConfigPath
  $configText = [IO.File]::ReadAllText($codexConfig, [Text.UTF8Encoding]::new($false))
  $header = "[mcp_servers.$Name]"
  $toolNames = @(
    'bridge_status', 'list_providers', 'route_preview', 'plan_task',
    'list_models', 'list_active_runs', 'bridge_activity', 'list_sessions',
    'read_session_output', 'list_collabs', 'read_collab', 'list_projects',
    'list_runs', 'get_run', 'list_receipts', 'get_receipt', 'get_context_bundle', 'start_bridge', 'restart_bridge',
    'stop_bridge', 'start_safe_session', 'send_session_input', 'stop_session',
    'ask_provider', 'route_and_ask', 'run_committee',
    'list_agents', 'set_agent_tags', 'broadcast',
    'submit_task', 'get_task', 'list_tasks', 'cancel_task',
    'provider_cooldowns', 'usage_gauges', 'usage_totals', 'usage_advise',
    # The GitHub tools landed after this list was last extended, so a Codex user
    # installed through this script silently lost the whole integration: the
    # tools are registered by mcp/server.mjs but never advertised, with no error
    # to notice. This is the local stdio adapter, which already exposes the
    # mutating surface (restart_bridge, stop_bridge, set_agent_tags) - the
    # read/write split in docs/CONNECTOR.md governs the remote profiles, not
    # this list.
    'github_repo_activity', 'github_list_versions', 'github_show_version',
    'github_checkout_version', 'github_track_run', 'github_link_issue',
    'github_onboard_repo'
  )
  $toolList = ($toolNames | ForEach-Object { '"' + $_ + '"' }) -join ', '
  $settings = @(
    'startup_timeout_sec = 15',
    "tool_timeout_sec = $mcpToolTimeoutSec",
    'required = false',
    'default_tools_approval_mode = "writes"',
    "enabled_tools = [$toolList]"
  ) -join "`r`n"
  if (-not $configText.Contains($header)) {
    throw "Codex created no $header section in $codexConfig"
  }
  $configText = $configText.Replace($header, "$header`r`n$settings")
  [IO.File]::WriteAllText($codexConfig, $configText, [Text.UTF8Encoding]::new($false))
  Write-Host "[RelayBridge] Codex MCP '$Name' registered." -ForegroundColor Green
}

if (-not $SkipClaude) {
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    throw 'Claude CLI is not installed or is not on PATH.'
  }
  # Claude reports a missing server on stderr. Treat that case as an
  # idempotent no-op while preserving fail-fast behavior for the add below.
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    & claude mcp remove --scope user $Name *> $null
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  # Use the argument-based form on Windows. PowerShell 5.1 can rewrite the
  # embedded quotes in an add-json payload before claude.exe receives it.
  & claude mcp add --scope user $Name `
    -e "RELAYBRIDGE_URL=$BridgeUrl" `
    -e "RELAYBRIDGE_TOKEN_FILE=$tokenFile" `
    -- $nodePath $mcpServer
  if ($LASTEXITCODE -ne 0) { throw "claude mcp add failed for $Name" }
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'SilentlyContinue'
    $claudeAdded = (& claude mcp get $Name 2>$null | Out-String)
    $claudeAddedExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $savedErrorActionPreference }
  $claudeVerified = $false
  try {
    $claudeEntry = $claudeAdded | ConvertFrom-Json
    $claudeServerVerified = @($claudeEntry.args | Where-Object {
      try { [string]::Equals([IO.Path]::GetFullPath([string]$_), [IO.Path]::GetFullPath($mcpServer), [StringComparison]::OrdinalIgnoreCase) }
      catch { $false }
    }).Count -gt 0
    $claudeVerified = $claudeServerVerified -and [string]$claudeEntry.env.RELAYBRIDGE_URL -eq $BridgeUrl -and
      [string]::Equals([string]$claudeEntry.env.RELAYBRIDGE_TOKEN_FILE, $tokenFile, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    $claudeVerified = $claudeAdded -match '(?i)mcp[\\/]+server\.mjs' -and
      $claudeAdded -match [regex]::Escape($BridgeUrl) -and $claudeAdded -match [regex]::Escape($tokenFile)
  }
  if ($claudeAddedExitCode -ne 0 -or -not $claudeVerified) {
    throw "Claude canonical MCP '$Name' did not verify after registration."
  }
  Write-Host "[RelayBridge] Claude MCP '$Name' registered." -ForegroundColor Green
}

# Promote the canonical registration first. Only then remove recognized legacy
# names whose current command actually targets a RelayBridge mcp/server.mjs.
foreach ($legacy in @($LegacyNames | Where-Object { $_ -and $_ -ne $Name } | Select-Object -Unique)) {
  if (-not $SkipCodex -and (Test-LegacyRelayBridgeRegistration codex $legacy)) {
    & codex mcp remove $legacy | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "codex mcp remove failed for legacy RelayBridge registration $legacy" }
    if (Test-LegacyRelayBridgeRegistration codex $legacy) { throw "Codex legacy MCP '$legacy' still exists after removal." }
    Write-Host "[RelayBridge] Codex legacy MCP '$legacy' migrated to '$Name'." -ForegroundColor Green
  }
  if (-not $SkipClaude -and (Test-LegacyRelayBridgeRegistration claude $legacy)) {
    & claude mcp remove --scope user $legacy | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "claude mcp remove failed for legacy RelayBridge registration $legacy" }
    if (Test-LegacyRelayBridgeRegistration claude $legacy) { throw "Claude legacy MCP '$legacy' still exists after removal." }
    Write-Host "[RelayBridge] Claude legacy MCP '$legacy' migrated to '$Name'." -ForegroundColor Green
  }
}
} catch {
  $registrationError = $_
  $rollbackErrors = @()
  foreach ($snapshot in $configurationSnapshots) {
    try { Restore-ConfigSnapshot $snapshot }
    catch { $rollbackErrors += "$($snapshot.Path): $($_.Exception.Message)" }
  }
  if ($rollbackErrors.Count) {
    Write-Warning ("MCP registration failed and rollback was incomplete: " + ($rollbackErrors -join '; '))
  } else {
    Write-Warning 'MCP registration failed; Codex and Claude configuration files were restored to their pre-install bytes.'
  }
  if ($tokenCreated -and (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
    Remove-Item -LiteralPath $tokenFile -Force -ErrorAction SilentlyContinue
  }
  throw $registrationError
}

Write-Host '[RelayBridge] Registration complete. Restart open Codex/Claude clients so they reload MCP configuration.' -ForegroundColor Cyan
} finally {
  Exit-McpRegistrationLock $registrationLock
}

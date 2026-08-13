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
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$codexConfigPath = Join-Path $env:USERPROFILE '.codex\config.toml'
$claudeConfigPath = Join-Path $env:USERPROFILE '.claude.json'

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

function Protect-CapabilityToken([string]$Path) {
  if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) { return }
  $identity = (& whoami.exe /user /fo csv /nh 2>$null | Out-String)
  $match = [regex]::Match($identity, 'S-[0-9]+(?:-[0-9]+)+')
  if (-not $match.Success) { throw 'Could not resolve the current Windows user SID for capability-token ACL hardening.' }
  $sid = $match.Value
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
$tokenCreated = $false
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
  Write-Host '[RelayBridge] Creating the local capability token...' -ForegroundColor Cyan
  $tokenBytes = New-Object byte[] 32
  $tokenRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $tokenRng.GetBytes($tokenBytes) } finally { $tokenRng.Dispose() }
  $token = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
  [IO.File]::WriteAllText($tokenFile, "$token`n", [Text.UTF8Encoding]::new($false))
  $tokenCreated = $true
} else {
  $existingToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
  if ($existingToken -notmatch '^[A-Fa-f0-9]{64}$') { throw "Existing RelayBridge capability token is invalid: $tokenFile" }
}
try { Protect-CapabilityToken $tokenFile }
catch {
  if ($tokenCreated) { Remove-Item -LiteralPath $tokenFile -Force -ErrorAction SilentlyContinue }
  throw
}

$configurationSnapshots = @()
if (-not $SkipCodex) { $configurationSnapshots += Get-ConfigSnapshot $codexConfigPath }
if (-not $SkipClaude) { $configurationSnapshots += Get-ConfigSnapshot $claudeConfigPath }

try {
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
  $configText = [IO.File]::ReadAllText($codexConfig)
  $header = "[mcp_servers.$Name]"
  $toolNames = @(
    'bridge_status', 'list_providers', 'route_preview', 'list_sessions',
    'read_session_output', 'list_collabs', 'read_collab', 'list_projects',
    'list_runs', 'get_run', 'list_receipts', 'get_receipt', 'get_context_bundle', 'start_bridge', 'restart_bridge',
    'stop_bridge', 'start_safe_session', 'send_session_input', 'stop_session',
    'ask_provider', 'route_and_ask', 'run_committee',
    'list_agents', 'set_agent_tags', 'broadcast'
  )
  $toolList = ($toolNames | ForEach-Object { '"' + $_ + '"' }) -join ', '
  $settings = @(
    'startup_timeout_sec = 15',
    'tool_timeout_sec = 360',
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

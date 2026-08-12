[CmdletBinding()]
param(
  [ValidatePattern('^[A-Za-z0-9_-]+$')]
  [string]$Name = 'relaybridge',

  [ValidatePattern('^http://127\.0\.0\.1(:[0-9]{1,5})?$')]
  [string]$BridgeUrl = 'http://127.0.0.1:8787',

  [switch]$SkipCodex,
  [switch]$SkipClaude
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$mcpServer = Join-Path $bridgeRoot 'mcp\server.mjs'
$tokenFile = Join-Path $bridgeRoot '.bridge-token'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$codexConfigPath = Join-Path $env:USERPROFILE '.codex\config.toml'
$claudeConfigPath = Join-Path $env:USERPROFILE '.claude.json'

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

if (-not (Test-Path -LiteralPath $mcpServer -PathType Leaf)) {
  throw "MCP server not found: $mcpServer"
}
if (-not (Test-Path -LiteralPath $tokenFile -PathType Leaf)) {
  Write-Host '[RelayBridge] Creating the local capability token...' -ForegroundColor Cyan
  $tokenBytes = New-Object byte[] 32
  $tokenRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $tokenRng.GetBytes($tokenBytes) } finally { $tokenRng.Dispose() }
  $token = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
  [IO.File]::WriteAllText($tokenFile, "$token`n", [Text.UTF8Encoding]::new($false))
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
  Write-Host "[RelayBridge] Claude MCP '$Name' registered." -ForegroundColor Green
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
  throw $registrationError
}

Write-Host '[RelayBridge] Registration complete. Restart open Codex/Claude clients so they reload MCP configuration.' -ForegroundColor Cyan

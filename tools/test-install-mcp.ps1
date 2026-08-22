[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('relaybridge-mcp-install-test-' + [Guid]::NewGuid().ToString('N'))
$bridgeRoot = Join-Path $testRoot 'RelayBridge'
$profileRoot = Join-Path $testRoot 'profile'
$fakeBin = Join-Path $testRoot 'bin'
$codexConfig = Join-Path $profileRoot '.codex\config.toml'
$claudeConfig = Join-Path $profileRoot '.claude.json'
$tokenFile = Join-Path $bridgeRoot '.bridge-token'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "ASSERTION FAILED: $Message" }
}

function Reset-Configs {
  $codex = @'
[mcp_servers.ps_bridge]
command = "node"
args = ["C:\legacy\RelayBridge\mcp\server.mjs"]

[mcp_servers.ps-bridge]
command = "node"
args = ["C:\other\server.js"]

[mcp_servers.unrelated]
command = "unrelated"
args = []
'@
  [IO.File]::WriteAllText($codexConfig, ($codex.Trim() + "`n"), [Text.UTF8Encoding]::new($false))
  $claude = [ordered]@{ mcpServers = [ordered]@{
    ps_bridge = [ordered]@{ type = 'stdio'; command = 'node'; args = @('C:\legacy\RelayBridge\mcp\server.mjs') }
    'ps-bridge' = [ordered]@{ type = 'stdio'; command = 'node'; args = @('C:\other\server.js') }
    unrelated = [ordered]@{ type = 'stdio'; command = 'unrelated'; args = @() }
  } }
  [IO.File]::WriteAllText($claudeConfig, (($claude | ConvertTo-Json -Depth 10) + "`n"), [Text.UTF8Encoding]::new($false))
}

New-Item -ItemType Directory -Path (Join-Path $bridgeRoot 'mcp'), (Join-Path $bridgeRoot 'config'), (Split-Path -Parent $codexConfig), $fakeBin -Force | Out-Null
try {
  Copy-Item -LiteralPath (Join-Path $repoRoot 'install-mcp.ps1') -Destination (Join-Path $bridgeRoot 'install-mcp.ps1')
  Copy-Item -LiteralPath (Join-Path $repoRoot 'config\timeout-policy.json') -Destination (Join-Path $bridgeRoot 'config\timeout-policy.json')
  [IO.File]::WriteAllText((Join-Path $bridgeRoot 'mcp\server.mjs'), "// fake MCP entrypoint`n", [Text.UTF8Encoding]::new($false))
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  $fakeClient = Join-Path $repoRoot 'test\fake-mcp-client.js'
  [IO.File]::WriteAllText((Join-Path $fakeBin 'codex.cmd'), "@echo off`r`n`"$nodePath`" `"$fakeClient`" codex %*`r`n", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $fakeBin 'claude.cmd'), "@echo off`r`n`"$nodePath`" `"$fakeClient`" claude %*`r`n", [Text.UTF8Encoding]::new($false))

  $previousPath = $env:Path
  $previousProfile = $env:USERPROFILE
  $previousFailure = $env:RELAYBRIDGE_FAKE_MCP_FAIL
  try {
    $env:Path = "$fakeBin;$previousPath"
    $env:USERPROFILE = $profileRoot
    Reset-Configs

    & (Join-Path $bridgeRoot 'install-mcp.ps1')
    $codexAfter = [IO.File]::ReadAllText($codexConfig, [Text.UTF8Encoding]::new($false))
    $claudeAfter = [IO.File]::ReadAllText($claudeConfig, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    Assert-True ($codexAfter -match '\[mcp_servers\.relaybridge\]') 'Codex canonical registration must be created'
    Assert-True ($codexAfter -match 'tool_timeout_sec = 2745') 'Codex MCP timeout must cover the 45-minute provider cap plus transport and host grace'
    Assert-True ($codexAfter -notmatch '\[mcp_servers\.ps_bridge\]') 'recognized Codex ps_bridge registration must be removed after promotion'
    Assert-True ($codexAfter -match '\[mcp_servers\.ps-bridge\]') 'non-RelayBridge lookalike registration must not be removed'
    Assert-True ($codexAfter -match '\[mcp_servers\.unrelated\]') 'unrelated Codex registration must be preserved'
    Assert-True ($null -ne $claudeAfter.mcpServers.relaybridge) 'Claude canonical registration must be created'
    Assert-True ($null -eq $claudeAfter.mcpServers.ps_bridge) 'recognized Claude ps_bridge registration must be removed after promotion'
    Assert-True ($null -ne $claudeAfter.mcpServers.'ps-bridge') 'non-RelayBridge Claude lookalike must not be removed'
    Assert-True ((Get-Content -LiteralPath $tokenFile -Raw).Trim() -match '^[a-f0-9]{64}$') 'MCP registration must create a valid capability token'
    $aclText = (& icacls.exe $tokenFile 2>$null | Out-String)
    Assert-True ($aclText -notmatch '\(I\)') 'new capability token must have inheritance removed'

    Remove-Item -LiteralPath $tokenFile -Force
    Reset-Configs
    $codexBeforeFailure = [Convert]::ToBase64String([IO.File]::ReadAllBytes($codexConfig))
    $claudeBeforeFailure = [Convert]::ToBase64String([IO.File]::ReadAllBytes($claudeConfig))
    $env:RELAYBRIDGE_FAKE_MCP_FAIL = 'claude-add'
    $failed = $false
    try { & (Join-Path $bridgeRoot 'install-mcp.ps1') }
    catch { $failed = $true }
    Assert-True $failed 'injected Claude registration failure must fail the transaction'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($codexConfig)) -eq $codexBeforeFailure) 'Codex config bytes must roll back after partial registration failure'
    Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($claudeConfig)) -eq $claudeBeforeFailure) 'Claude config bytes must roll back after partial registration failure'
    Assert-True (-not (Test-Path -LiteralPath $tokenFile)) 'new token must be removed when registration rolls back'

    Write-Host '[RelayBridge] MCP canonical-name migration and rollback test passed.' -ForegroundColor Green
  } finally {
    $env:Path = $previousPath
    $env:USERPROFILE = $previousProfile
    $env:RELAYBRIDGE_FAKE_MCP_FAIL = $previousFailure
  }
} finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
  $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if ($resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedTestRoot) -like 'relaybridge-mcp-install-test-*') {
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

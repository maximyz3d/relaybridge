[CmdletBinding()]
param(
  # Repo/install root containing mcp\server.mjs
  [string]$Root = $(if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }),
  [int]$Port = 8787,
  # Print what would be written without touching anything.
  [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

$serverPath = Join-Path $Root 'mcp\server.mjs'
if (-not (Test-Path -LiteralPath $serverPath)) { throw "mcp\server.mjs not found under $Root" }

$nodeCmd = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $nodeCmd) { throw 'node is not on PATH; MCP clients need it to launch the server.' }
$nodePath = $nodeCmd.Source

# One server definition, written into each client's own config shape. Every
# MCP client speaks the same stdio protocol, they just disagree about where the
# config lives and what the top-level key is called.
function New-ServerEntry {
  @{
    command = $nodePath
    args    = @($serverPath)
    env     = @{ RELAYBRIDGE_PORT = "$Port" }
  }
}

# Merges into existing JSON rather than overwriting: these files hold the user's
# other servers and settings, and clobbering them would break unrelated tools.
function Merge-McpConfig {
  param([string]$File, [string]$Key, [string]$Label)

  try {
    $dir = Split-Path -Parent $File
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
      Write-Host "[RelayBridge] skip $Label (not installed: $dir)" -ForegroundColor DarkGray
      return
    }

    $root = @{}
    if (Test-Path -LiteralPath $File) {
      $raw = Get-Content -Raw -LiteralPath $File
      if ($raw -and $raw.Trim()) {
        try {
          $parsed = $raw | ConvertFrom-Json -ErrorAction Stop
          # Convert PSCustomObject to hashtable so we can merge predictably.
          $root = @{}
          foreach ($prop in $parsed.PSObject.Properties) { $root[$prop.Name] = $prop.Value }
        } catch {
          Write-Host "[RelayBridge] $Label config is not valid JSON; leaving it alone ($File)" -ForegroundColor Yellow
          return
        }
      }
    }

    $servers = @{}
    if ($root.ContainsKey($Key) -and $root[$Key]) {
      foreach ($prop in $root[$Key].PSObject.Properties) { $servers[$prop.Name] = $prop.Value }
    }
    $servers['relaybridge'] = New-ServerEntry
    $root[$Key] = $servers

    if ($WhatIfOnly) {
      Write-Host "[RelayBridge] would write $Label -> $File" -ForegroundColor Cyan
      return
    }

    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # WriteAllText avoids the UTF-8 BOM that Set-Content adds, which breaks
    # JSON.parse in several clients.
    [IO.File]::WriteAllText($File, ($root | ConvertTo-Json -Depth 12))
    Write-Host "[RelayBridge] registered with $Label ($File)" -ForegroundColor Green
  } catch {
    Write-Host "[RelayBridge] could not register $Label : $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# $HOME is a read-only automatic variable in PowerShell; use our own name.
$userHome = $env:USERPROFILE
$appdata = $env:APPDATA

# Claude Desktop and Cowork share one config file.
Merge-McpConfig -File (Join-Path $appdata 'Claude\claude_desktop_config.json') -Key 'mcpServers' -Label 'Claude Desktop / Cowork'
# Cursor (and Cursor Agent) read user-level MCP from ~/.cursor/mcp.json
Merge-McpConfig -File (Join-Path $userHome '.cursor\mcp.json') -Key 'mcpServers' -Label 'Cursor'
# Gemini CLI / Antigravity
Merge-McpConfig -File (Join-Path $userHome '.gemini\settings.json') -Key 'mcpServers' -Label 'Gemini / Antigravity'
# VS Code (Copilot agent mode) uses "servers"
Merge-McpConfig -File (Join-Path $userHome '.vscode\mcp.json') -Key 'servers' -Label 'VS Code / Copilot'
# Windsurf, Zed and several others follow the mcpServers shape too.
Merge-McpConfig -File (Join-Path $userHome '.codeium\windsurf\mcp_config.json') -Key 'mcpServers' -Label 'Windsurf'

# A portable copy any other client can be pointed at by hand.
$portable = Join-Path $Root 'mcp-config.json'
if (-not $WhatIfOnly) {
  [IO.File]::WriteAllText($portable, (@{ mcpServers = @{ relaybridge = (New-ServerEntry) } } | ConvertTo-Json -Depth 12))
  Write-Host "[RelayBridge] portable config written to $portable" -ForegroundColor Green
}

Write-Host ''
Write-Host '[RelayBridge] Restart any running client so it reloads MCP configuration.' -ForegroundColor Cyan
Write-Host '[RelayBridge] Claude Code and Codex are registered separately by install-mcp.ps1.' -ForegroundColor Gray

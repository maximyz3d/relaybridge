[CmdletBinding()]
param(
  # Where this repo lives; defaults to the folder containing this script.
  [string]$SourceDir = '',
  [switch]$ClaudeOnly,
  [switch]$CodexOnly,
  # Skip writing the always-loaded primer into agent memory files.
  [switch]$NoMemory,
  # Also register the RelayBridge MCP server with Claude Code and Codex.
  [switch]$RegisterMcp
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 can evaluate parameter-default expressions before
# $PSScriptRoot is populated. Resolve the bundled skill only after entering the
# script body so invoking this file from an unrelated cwd remains reliable.
if (-not $SourceDir) {
  $scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
  if (-not $scriptRoot) { throw 'Could not resolve the RelayBridge skill installer directory.' }
  $SourceDir = Join-Path $scriptRoot 'skills\relaybridge'
}

if (-not (Test-Path -LiteralPath $SourceDir)) {
  throw "Skill source not found at $SourceDir"
}

$begin = '<!-- BEGIN relaybridge-primer -->'
$end   = '<!-- END relaybridge-primer -->'

# A skill is loaded on demand; an agent only reads it once it decides the task
# looks relevant. Memory files are loaded on EVERY session, which is what makes
# the bridge impossible to forget. The primer is deliberately short for exactly
# that reason and points at the full skill for detail.
function Write-MemoryBlock {
  param([string]$File, [string]$Body, [string]$Label)

  $block = "$begin`r`n$Body`r`n$end"
  $dir = Split-Path -Parent $File
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  if (Test-Path -LiteralPath $File) {
    $existing = [IO.File]::ReadAllText($File, [Text.UTF8Encoding]::new($false))
    if ($existing -match [regex]::Escape($begin)) {
      # Refresh in place: re-running must never duplicate the block, and must
      # never disturb instructions the user wrote themselves.
      $pattern = [regex]::Escape($begin) + '[\s\S]*?' + [regex]::Escape($end)
      $updated = [regex]::Replace($existing, $pattern, { param($m) $block })
      [IO.File]::WriteAllText($File, $updated, [Text.UTF8Encoding]::new($false))
      Write-Host "[RelayBridge] refreshed primer in $Label ($File)" -ForegroundColor Green
    } else {
      [IO.File]::WriteAllText($File, ($existing.TrimEnd() + "`r`n`r`n" + $block + "`r`n"), [Text.UTF8Encoding]::new($false))
      Write-Host "[RelayBridge] appended primer to $Label ($File)" -ForegroundColor Green
    }
  } else {
    [IO.File]::WriteAllText($File, $block + "`r`n", [Text.UTF8Encoding]::new($false))
    Write-Host "[RelayBridge] created $Label ($File)" -ForegroundColor Green
  }
}

$primerPath = Join-Path $SourceDir 'PRIMER.md'
if (-not (Test-Path -LiteralPath $primerPath)) { throw "PRIMER.md not found in $SourceDir" }
$primer = [IO.File]::ReadAllText($primerPath, [Text.UTF8Encoding]::new($false))

# --- Claude Code: skill folder (on demand) + CLAUDE.md (every session) --------
if (-not $CodexOnly) {
  $claudeTarget = Join-Path $env:USERPROFILE '.claude\skills\relaybridge'
  New-Item -ItemType Directory -Path $claudeTarget -Force | Out-Null
  Copy-Item -Path (Join-Path $SourceDir '*') -Destination $claudeTarget -Recurse -Force
  Write-Host "[RelayBridge] Claude skill installed to $claudeTarget" -ForegroundColor Green

  if (-not $NoMemory) {
    $body = $primer + "`r`n`r`nFull skill: $claudeTarget\SKILL.md"
    Write-MemoryBlock -File (Join-Path $env:USERPROFILE '.claude\CLAUDE.md') -Body $body -Label 'Claude Code user memory'
  }
}

# --- Codex: guide folder + AGENTS.md (loaded every session) -------------------
if (-not $ClaudeOnly) {
  $codexDir = Join-Path $env:USERPROFILE '.codex\relaybridge'
  New-Item -ItemType Directory -Path $codexDir -Force | Out-Null
  Copy-Item -Path (Join-Path $SourceDir '*') -Destination $codexDir -Recurse -Force
  Write-Host "[RelayBridge] Codex guide installed to $codexDir" -ForegroundColor Green

  if (-not $NoMemory) {
    $body = $primer + "`r`n`r`nFull guide: $codexDir\AGENTS.md"
    Write-MemoryBlock -File (Join-Path $env:USERPROFILE '.codex\AGENTS.md') -Body $body -Label 'Codex global instructions'
  }
}

# --- Other agents on this machine --------------------------------------------
# Each reads a different always-loaded file. Writing the same primer everywhere
# means whichever agent the user opens already knows the bridge exists.
if (-not $NoMemory -and -not $ClaudeOnly -and -not $CodexOnly) {
  $shared = Join-Path $env:USERPROFILE '.claude\skills\relaybridge'
  $body = $primer + "`r`n`r`nFull reference: $shared\SKILL.md and $shared\reference.md"

  Write-MemoryBlock -File (Join-Path $env:USERPROFILE '.gemini\GEMINI.md') -Body $body -Label 'Gemini CLI memory'
  # Cursor reads user rules from ~/.cursor/rules/*.mdc in current builds; if this
  # version does not, the file is inert rather than harmful.
  Write-MemoryBlock -File (Join-Path $env:USERPROFILE '.cursor\rules\relaybridge.mdc') -Body $body -Label 'Cursor user rules'
  Write-MemoryBlock -File (Join-Path $env:USERPROFILE '.config\relaybridge\AGENTS.md') -Body $body -Label 'generic agent instructions'
}

# --- MCP registration ---------------------------------------------------------
if ($RegisterMcp) {
  $mcpScript = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'install-mcp.ps1' } else { Join-Path (Get-Location) 'install-mcp.ps1' }
  if (Test-Path -LiteralPath $mcpScript) {
    Write-Host '[RelayBridge] registering the MCP server with Claude Code and Codex...' -ForegroundColor Cyan
    & $mcpScript
  } else {
    Write-Host "[RelayBridge] install-mcp.ps1 not found next to this script; run it from the repo root to register MCP." -ForegroundColor Yellow
  }
} else {
  Write-Host '[RelayBridge] Tip: re-run with -RegisterMcp to also register the MCP server (tools instead of raw HTTP).' -ForegroundColor Gray
}

Write-Host ''
Write-Host '[RelayBridge] Done. Agents load the primer every session; the full skill is read on demand.' -ForegroundColor Green

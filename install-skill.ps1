[CmdletBinding()]
param(
  # Where this repo lives; defaults to the folder containing this script.
  [string]$SourceDir = (Join-Path $PSScriptRoot 'skills\relaybridge'),
  [switch]$ClaudeOnly,
  [switch]$CodexOnly
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $SourceDir)) {
  throw "Skill source not found at $SourceDir"
}

# Claude Code reads personal skills from ~/.claude/skills/<name>/SKILL.md.
if (-not $CodexOnly) {
  $claudeTarget = Join-Path $env:USERPROFILE '.claude\skills\relaybridge'
  New-Item -ItemType Directory -Path $claudeTarget -Force | Out-Null
  Copy-Item -Path (Join-Path $SourceDir '*') -Destination $claudeTarget -Recurse -Force
  Write-Host "[RelayBridge] Claude skill installed to $claudeTarget" -ForegroundColor Green
  Write-Host '  Claude Code picks it up on next start; ask it to "use the relaybridge skill" to confirm.' -ForegroundColor Gray
}

# Codex reads AGENTS.md. We keep our copy in its own folder and reference it
# from the global file with idempotent markers, so a re-run never duplicates
# the block and the user's own instructions are left intact.
if (-not $ClaudeOnly) {
  $codexDir = Join-Path $env:USERPROFILE '.codex\relaybridge'
  New-Item -ItemType Directory -Path $codexDir -Force | Out-Null
  Copy-Item -Path (Join-Path $SourceDir '*') -Destination $codexDir -Recurse -Force

  $globalAgents = Join-Path $env:USERPROFILE '.codex\AGENTS.md'
  $begin = '<!-- BEGIN relaybridge-skill -->'
  $end   = '<!-- END relaybridge-skill -->'
  $block = @"
$begin
## RelayBridge

This machine runs RelayBridge, a local control plane on http://127.0.0.1:8787
for delegating work to other AI CLIs and matching the model to task difficulty.
Read $codexDir\AGENTS.md before delegating, and follow its routing ladder.
$end
"@

  if (Test-Path -LiteralPath $globalAgents) {
    $existing = Get-Content -Raw -LiteralPath $globalAgents
    if ($existing -match [regex]::Escape($begin)) {
      $pattern = [regex]::Escape($begin) + '[\s\S]*?' + [regex]::Escape($end)
      $updated = [regex]::Replace($existing, $pattern, [System.Text.RegularExpressions.MatchEvaluator]{ param($m) $block })
      Set-Content -LiteralPath $globalAgents -Value $updated -Encoding UTF8
      Write-Host "[RelayBridge] Refreshed the existing block in $globalAgents" -ForegroundColor Green
    } else {
      Add-Content -LiteralPath $globalAgents -Value "`n$block" -Encoding UTF8
      Write-Host "[RelayBridge] Appended pointer to $globalAgents" -ForegroundColor Green
    }
  } else {
    Set-Content -LiteralPath $globalAgents -Value $block -Encoding UTF8
    Write-Host "[RelayBridge] Created $globalAgents" -ForegroundColor Green
  }
  Write-Host "[RelayBridge] Codex guide installed to $codexDir" -ForegroundColor Green
}

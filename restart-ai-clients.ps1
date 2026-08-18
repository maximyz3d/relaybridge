<#
.SYNOPSIS
Fully restarts the AI clients so they reload MCP configuration and agent memory.

.DESCRIPTION
Closing an Electron app's window does not end it. Claude Desktop, Cursor and
Antigravity all leave tray, GPU and renderer helper processes running, and those
survivors keep the OLD mcp config and memory files in memory. The app then
"reopens" from the surviving process and nothing appears to have changed.

This closes each client properly: ask nicely first (CloseMainWindow, so unsaved
work prompts still appear), wait, then force-stop whatever is left, confirm the
port of exit, and relaunch from the executable path captured beforehand.

Claude Code and Codex are CLIs, not daemons — they read config at invocation, so
simply opening a new terminal is enough. They are reported, not killed.

.EXAMPLE
  .\restart-ai-clients.ps1 -WhatIf      # show what would happen
  .\restart-ai-clients.ps1              # graceful close, force after 8s, relaunch
  .\restart-ai-clients.ps1 -NoRelaunch  # close only
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  # Seconds to wait for a graceful close before forcing.
  [int]$GraceSeconds = 8,
  # Close without starting the apps again.
  [switch]$NoRelaunch,
  # Restart only these (by key): claude, cursor, antigravity, vscode, windsurf.
  [string[]]$Only = @()
)

$ErrorActionPreference = 'Stop'

# Exact process names only. Killing by wildcard here would be dangerous: "Code"
# and "Claude" are common substrings, and this script force-terminates.
$clients = @(
  @{ Key = 'claude';      Label = 'Claude Desktop / Cowork'; Names = @('Claude') }
  @{ Key = 'cursor';      Label = 'Cursor';                  Names = @('Cursor') }
  @{ Key = 'antigravity'; Label = 'Gemini / Antigravity';    Names = @('Antigravity') }
  @{ Key = 'vscode';      Label = 'VS Code';                 Names = @('Code') }
  @{ Key = 'windsurf';    Label = 'Windsurf';                Names = @('Windsurf') }
)

if ($Only.Count) {
  $wanted = $Only | ForEach-Object { $_.ToLower() }
  $clients = $clients | Where-Object { $wanted -contains $_.Key }
  if (-not $clients) { throw "no known clients matched: $($Only -join ', ')" }
}

$restarted = @()
$missing = @()

foreach ($client in $clients) {
  $procs = @()
  foreach ($name in $client.Names) {
    $procs += @(Get-Process -Name $name -ErrorAction SilentlyContinue)
  }
  if (-not $procs.Count) {
    $missing += $client.Label
    continue
  }

  # Capture the exe path BEFORE killing: afterwards there is nothing to ask.
  # The main window owner is the right one to relaunch; helpers share the path
  # but are started by the parent, so any non-empty path works.
  $exe = ($procs | Where-Object { $_.Path } | Select-Object -First 1).Path
  $count = $procs.Count

  if (-not $PSCmdlet.ShouldProcess("$($client.Label) ($count process(es))", 'restart')) { continue }

  Write-Host "[restart] $($client.Label): $count process(es)" -ForegroundColor Cyan

  # Graceful first so unsaved-work prompts still appear.
  foreach ($p in $procs) {
    try { if (-not $p.HasExited) { $null = $p.CloseMainWindow() } } catch { }
  }

  $deadline = (Get-Date).AddSeconds($GraceSeconds)
  while ((Get-Date) -lt $deadline) {
    $alive = @()
    foreach ($name in $client.Names) { $alive += @(Get-Process -Name $name -ErrorAction SilentlyContinue) }
    if (-not $alive.Count) { break }
    Start-Sleep -Milliseconds 400
  }

  # Whatever survived is a tray/GPU/renderer helper holding the old config.
  $stubborn = @()
  foreach ($name in $client.Names) { $stubborn += @(Get-Process -Name $name -ErrorAction SilentlyContinue) }
  if ($stubborn.Count) {
    Write-Host "[restart]   $($stubborn.Count) helper process(es) survived the close; forcing" -ForegroundColor DarkGray
    foreach ($p in $stubborn) {
      try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    Start-Sleep -Milliseconds 800
  }

  $leftover = @()
  foreach ($name in $client.Names) { $leftover += @(Get-Process -Name $name -ErrorAction SilentlyContinue) }
  if ($leftover.Count) {
    Write-Host "[restart]   WARNING: $($leftover.Count) process(es) still running; config may not reload" -ForegroundColor Yellow
  } else {
    Write-Host "[restart]   stopped cleanly" -ForegroundColor Green
  }

  if (-not $NoRelaunch) {
    if ($exe -and (Test-Path -LiteralPath $exe)) {
      Start-Process -FilePath $exe | Out-Null
      Write-Host "[restart]   relaunched $exe" -ForegroundColor Green
      $restarted += $client.Label
    } else {
      Write-Host "[restart]   could not determine the executable path; start it from the Start menu" -ForegroundColor Yellow
    }
  }
}

Write-Host ''
if ($restarted.Count) { Write-Host "restarted: $($restarted -join ', ')" -ForegroundColor Green }
if ($missing.Count)   { Write-Host "not running (nothing to do): $($missing -join ', ')" -ForegroundColor DarkGray }
Write-Host 'Claude Code and Codex are CLIs — they read config per invocation, so a new terminal is enough.' -ForegroundColor Gray
Write-Host ''
Write-Host 'Verify a client actually picked up the bridge by asking it:' -ForegroundColor Cyan
Write-Host '  "use plan_task to decide how to add a tooltip to a button"' -ForegroundColor Gray
Write-Host 'It should answer with a cheap provider at low effort, not a frontier model.' -ForegroundColor Gray

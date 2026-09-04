[CmdletBinding()]
param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$serverPath = Join-Path $bridgeRoot 'server.js'
$dependencyPath = Join-Path $bridgeRoot 'node_modules\express\package.json'
$buildInfoTool = Join-Path $bridgeRoot 'tools\prepare-build-info.cjs'

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) {
  throw 'Node.js 20.3 or newer is required. Install it from https://nodejs.org and rerun this command.'
}
if (-not (Test-Path -LiteralPath $dependencyPath -PathType Leaf)) {
  throw "Locked dependencies are missing. Run 'npm ci --no-audit --no-fund' once in $bridgeRoot, then start again."
}
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "RelayBridge server not found: $serverPath" }
if (-not (Test-Path -LiteralPath $buildInfoTool -PathType Leaf)) { throw "Build identity tool not found: $buildInfoTool" }

$preparedBuildText = (& $nodeCommand.Source $buildInfoTool $bridgeRoot | Out-String).Trim()
$preparedBuildExitCode = $LASTEXITCODE
if ($preparedBuildExitCode -ne 0 -or $preparedBuildText -notmatch '^[A-Za-z0-9._+-]{1,128}$') {
  throw 'RelayBridge could not prepare or validate an exact build identity; no listener was started.'
}
$expectedBuildId = $preparedBuildText
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$baseUrl = "http://127.0.0.1:$port"

function Get-Health {
  try { return Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2 -UseBasicParsing }
  catch { return $null }
}

$existing = Get-Health
if ($existing) {
  if (-not $existing.capabilityAuth -or $existing.buildIdentityReady -ne $true -or
      [string]$existing.buildId -ne $expectedBuildId) {
    throw "Port $port is already serving RelayBridge build '$($existing.buildId)' instead of '$expectedBuildId'. Stop the owning install explicitly before starting this one."
  }
  Write-Host "[RelayBridge] build $expectedBuildId is already healthy at $baseUrl" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process $baseUrl }
  return
}

$stdout = Join-Path $bridgeRoot 'bridge.start.out.log'
$stderr = Join-Path $bridgeRoot 'bridge.start.err.log'
$previousExpectedBuildId = $env:RELAYBRIDGE_EXPECTED_BUILD_ID
try {
  $env:RELAYBRIDGE_EXPECTED_BUILD_ID = $expectedBuildId
  $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList 'server.js' -WorkingDirectory $bridgeRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
} finally {
  $env:RELAYBRIDGE_EXPECTED_BUILD_ID = $previousExpectedBuildId
}
for ($attempt = 0; $attempt -lt 100; $attempt++) {
  if ($process.HasExited) { throw "RelayBridge exited with code $($process.ExitCode). See $stderr" }
  $health = Get-Health
  if ($health) {
    $reportedPid = try { [int64]$health.pid } catch { 0 }
    if ($reportedPid -ne [int64]$process.Id -or -not $health.capabilityAuth -or $health.buildIdentityReady -ne $true -or
        [string]$health.buildId -ne $expectedBuildId) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "Port $port reported PID '$reportedPid' and build '$($health.buildId)' instead of candidate PID '$($process.Id)' and build '$expectedBuildId'."
    }
    Write-Host "[RelayBridge] build $expectedBuildId is healthy at $baseUrl (PID $($process.Id))" -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process $baseUrl }
    return
  }
  Start-Sleep -Milliseconds 100
}
Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
throw "RelayBridge did not become healthy at $baseUrl. See $stderr"

[CmdletBinding()]
param(
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$bridgeRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$serverPath = Join-Path $bridgeRoot 'server.js'
$packagePath = Join-Path $bridgeRoot 'package.json'
$dependencyPath = Join-Path $bridgeRoot 'node_modules\express\package.json'

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw 'Node.js 20.3 or newer is required. Install it from https://nodejs.org and rerun this command.'
}
if (-not (Test-Path -LiteralPath $dependencyPath -PathType Leaf)) {
  throw "Locked dependencies are missing. Run 'npm ci --no-audit --no-fund' once in $bridgeRoot, then start again."
}
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw "RelayBridge server not found: $serverPath" }

$package = [IO.File]::ReadAllText($packagePath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$expectedBuildId = [string]$package.version
$buildInfoPath = Join-Path $bridgeRoot 'build-info.json'
if (Test-Path -LiteralPath $buildInfoPath -PathType Leaf) {
  $buildInfo = [IO.File]::ReadAllText($buildInfoPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  if ($buildInfo.buildId) { $expectedBuildId = [string]$buildInfo.buildId }
}
$port = if ($env:PORT) { [int]$env:PORT } else { 8787 }
$baseUrl = "http://127.0.0.1:$port"

function Get-Health {
  try { return Invoke-RestMethod -Uri "$baseUrl/api/health" -TimeoutSec 2 -UseBasicParsing }
  catch { return $null }
}

$existing = Get-Health
if ($existing) {
  if (-not $existing.capabilityAuth -or [string]$existing.buildId -ne $expectedBuildId) {
    throw "Port $port is already serving RelayBridge build '$($existing.buildId)' instead of '$expectedBuildId'. Stop the owning install explicitly before starting this one."
  }
  Write-Host "[RelayBridge] build $expectedBuildId is already healthy at $baseUrl" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process $baseUrl }
  return
}

$stdout = Join-Path $bridgeRoot 'bridge.start.out.log'
$stderr = Join-Path $bridgeRoot 'bridge.start.err.log'
$process = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'server.js' -WorkingDirectory $bridgeRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
for ($attempt = 0; $attempt -lt 100; $attempt++) {
  if ($process.HasExited) { throw "RelayBridge exited with code $($process.ExitCode). See $stderr" }
  $health = Get-Health
  if ($health) {
    if (-not $health.capabilityAuth -or [string]$health.buildId -ne $expectedBuildId) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      throw "Port $port reported build '$($health.buildId)' instead of '$expectedBuildId'."
    }
    Write-Host "[RelayBridge] build $expectedBuildId is healthy at $baseUrl (PID $($process.Id))" -ForegroundColor Green
    if (-not $NoBrowser) { Start-Process $baseUrl }
    return
  }
  Start-Sleep -Milliseconds 100
}
Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
throw "RelayBridge did not become healthy at $baseUrl. See $stderr"

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$TargetPid,

  [ValidateRange(1, 65535)]
  [int]$Port = 8787,

  [string]$BridgeRoot = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path -LiteralPath $BridgeRoot).Path
$serverPath = Join-Path $resolvedRoot 'server.js'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
  throw "RelayBridge server not found: $serverPath"
}

# Give the API request that launched this helper time to return to its caller.
Start-Sleep -Milliseconds 1000

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($listener -and [int]$listener.OwningProcess -ne $TargetPid) {
  throw "Port $Port is now owned by PID $($listener.OwningProcess), not expected PID $TargetPid."
}
if ($listener) {
  Stop-Process -Id $TargetPid -Force -ErrorAction Stop
}

for ($attempt = 0; $attempt -lt 40; $attempt++) {
  if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
    break
  }
  Start-Sleep -Milliseconds 100
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw "Port $Port did not become available after stopping PID $TargetPid."
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
Start-Process -FilePath $nodePath -ArgumentList 'server.js' -WorkingDirectory $resolvedRoot -WindowStyle Hidden

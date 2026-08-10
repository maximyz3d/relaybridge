# RelayBridge launcher (PowerShell)
# Run with:  powershell -ExecutionPolicy Bypass -File .\start.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '[RelayBridge] Node.js not found on PATH.' -ForegroundColor Red
    Write-Host 'Install Node 20+ from https://nodejs.org and re-run.' -ForegroundColor Yellow
    Read-Host 'Press Enter to exit'
    exit 1
}

Write-Host '[RelayBridge] Synchronizing locked dependencies...' -ForegroundColor Cyan
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Write-Host '[RelayBridge] npm install hit an issue (likely node-pty native compile).' -ForegroundColor Yellow
    Write-Host '[RelayBridge] Retrying without optional deps -- bridge will run in pipe mode.' -ForegroundColor Yellow
    npm install --no-audit --no-fund --no-optional
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
}

$port = if ($env:PORT) { $env:PORT } else { '8787' }
Write-Host "[RelayBridge] starting on http://127.0.0.1:$port" -ForegroundColor Green
Start-Process "http://127.0.0.1:$port"
node server.js

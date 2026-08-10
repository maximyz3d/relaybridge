@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [RelayBridge] Node.js not found on PATH.
  echo Install Node 20+ from https://nodejs.org and re-run this script.
  pause
  exit /b 1
)

echo [RelayBridge] Synchronizing locked dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [RelayBridge] npm install failed. If node-pty errors, retrying without optional deps.
  call npm install --no-audit --no-fund --no-optional
  if errorlevel 1 exit /b 1
)

echo [RelayBridge] starting on http://127.0.0.1:8787
start "" "http://127.0.0.1:8787"
node server.js
endlocal

[CmdletBinding()]
param(
  [string]$Repo = 'maximyz3d/relaybridge',
  [string]$Branch = 'main',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'RelayBridge'),
  [switch]$NoStart,
  [switch]$RegisterMcp
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw 'Node.js 20.3 or newer is required. Install it from https://nodejs.org and rerun this command.'
}

$nodeVersion = (& node.exe -p "process.versions.node").Trim()
$majorMinor = $nodeVersion.Split('.')
if ([int]$majorMinor[0] -lt 20 -or ([int]$majorMinor[0] -eq 20 -and [int]$majorMinor[1] -lt 3)) {
  throw "Node.js $nodeVersion is installed, but RelayBridge requires 20.3 or newer."
}

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("relaybridge-install-" + [Guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'source.zip'
$extractRoot = Join-Path $tempRoot 'extract'
New-Item -ItemType Directory -Path $tempRoot, $extractRoot -Force | Out-Null

try {
  $zipUrl = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
  Write-Host "[RelayBridge] Downloading $Repo@$Branch..." -ForegroundColor Cyan
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
  $sourceRoot = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
  if (-not $sourceRoot) { throw 'Downloaded archive did not contain a source directory.' }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $runtimeNames = @('.bridge-token', '.state.json', '.mcp-start.lock', 'data', 'node_modules')
  Get-ChildItem -LiteralPath $sourceRoot.FullName -Force | ForEach-Object {
    if ($runtimeNames -contains $_.Name) { return }
    $target = Join-Path $InstallDir $_.Name
    if ($_.PSIsContainer) {
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
    } else {
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }

  Set-Location -LiteralPath $InstallDir
  Write-Host '[RelayBridge] Installing locked dependencies...' -ForegroundColor Cyan
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host '[RelayBridge] Retrying without optional native PTY dependency; terminal sessions will use pipe mode.' -ForegroundColor Yellow
    npm install --no-audit --no-fund --no-optional
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }
  }

  if ($RegisterMcp) {
    & (Join-Path $InstallDir 'install-mcp.ps1')
  }

  if (-not $NoStart) {
    & (Join-Path $InstallDir 'start.ps1')
  } else {
    Write-Host "[RelayBridge] Installed at $InstallDir" -ForegroundColor Green
  }
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

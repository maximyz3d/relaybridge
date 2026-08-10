[CmdletBinding()]
param(
  [string]$InstallUrl = 'https://raw.githubusercontent.com/maximyz3d/relaybridge/main/install.ps1',
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'

$verifyRoot = Join-Path ([IO.Path]::GetTempPath()) ('relaybridge-verify-' + [Guid]::NewGuid().ToString('N'))
$installDir = Join-Path $verifyRoot 'RelayBridge'
$installerPath = Join-Path $verifyRoot 'install.ps1'

New-Item -ItemType Directory -Path $verifyRoot -Force | Out-Null

try {
  Invoke-WebRequest -Uri $InstallUrl -OutFile $installerPath -UseBasicParsing
  & $installerPath -NoStart -InstallDir $installDir

  foreach ($required in @('server.js', 'README.md', 'install-mcp.ps1', 'mcp/server.mjs')) {
    $path = Join-Path $installDir $required
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Missing installed file: $required"
    }
  }

  Push-Location -LiteralPath $installDir
  try {
    npm test
    if ($LASTEXITCODE -ne 0) { throw "npm test failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  Write-Host "[RelayBridge] Remote installer verification passed: $InstallUrl" -ForegroundColor Green
} finally {
  if (-not $KeepTemp -and (Test-Path -LiteralPath $verifyRoot)) {
    $resolvedVerifyRoot = (Resolve-Path -LiteralPath $verifyRoot).Path
    $tempBase = [IO.Path]::GetTempPath().TrimEnd('\')
    if ($resolvedVerifyRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedVerifyRoot -Recurse -Force -ErrorAction SilentlyContinue
    } else {
      Write-Warning "Refusing cleanup outside temp: $resolvedVerifyRoot"
    }
  }
}

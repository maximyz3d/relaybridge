[CmdletBinding()]
param(
  [string]$Repo = 'maximyz3d/relaybridge',
  [string]$Branch = 'main',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'RelayBridge'),
  [switch]$NoStart,
  [switch]$RegisterMcp,
  [string[]]$Providers = @(),
  [switch]$SkipProviderSetup
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

# ---------- AI provider CLI setup helpers ----------

function Add-UserToolPath {
  # Make freshly installed user-level CLIs resolvable in this same session.
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'agy\bin'),
    (Join-Path $env:USERPROFILE '.local\bin'),
    (Join-Path $env:USERPROFILE '.cursor\bin'),
    (Join-Path $env:APPDATA 'npm'),
    (Join-Path $env:LOCALAPPDATA 'npm')
  )
  foreach ($dir in $candidates) {
    if ($dir -and (Test-Path -LiteralPath $dir) -and ((($env:Path) -split ';') -notcontains $dir)) {
      $env:Path = $dir + ';' + $env:Path
    }
  }
}

function Get-ProviderGroups {
  param([string]$ConfigPath)
  # Groups provider seats that share one installer (e.g. Claude Code + Fable are
  # one npm package; the four local Ollama seats are one winget install).
  $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  $groups = @()
  foreach ($prop in $config.PSObject.Properties) {
    $kind = $prop.Name
    $entry = $prop.Value
    if ($kind.StartsWith('_') -or $kind -eq 'powershell') { continue }
    if ($entry.PSObject.Properties['oneshot_adapter'] -and $entry.oneshot_adapter -eq 'openai_chat_api') { continue } # hosted API seat, no CLI
    $installCmd = @()
    if ($entry.PSObject.Properties['install_command']) { $installCmd = @($entry.install_command) }
    $npmPkg = ''
    if ($entry.PSObject.Properties['npm_package']) { $npmPkg = [string]$entry.npm_package }
    $pipPkg = ''
    if ($entry.PSObject.Properties['pip_package']) { $pipPkg = [string]$entry.pip_package }
    $display = ''
    if ($entry.PSObject.Properties['install_display']) { $display = [string]$entry.install_display }
    if (-not $installCmd -and -not $npmPkg -and -not $pipPkg -and -not $display) { continue }
    $binary = ''
    if ($entry.PSObject.Properties['diagnostic_binary']) { $binary = [string]$entry.diagnostic_binary }
    elseif ($entry.PSObject.Properties['safe'] -and @($entry.safe).Count -gt 0) { $binary = [string](@($entry.safe)[0]) }
    $postInstall = ''
    if ($entry.PSObject.Properties['post_install']) { $postInstall = [string]$entry.post_install }
    if ($installCmd.Count -gt 0) { $key = 'cmd:' + ($installCmd -join ' ') }
    elseif ($npmPkg) { $key = 'npm:' + $npmPkg }
    elseif ($pipPkg) { $key = 'pip:' + $pipPkg }
    else { $key = 'iex:' + $display }
    $member = [pscustomobject]@{ Kind = $kind; Label = [string]$entry.label; PostInstall = $postInstall }
    $existing = $groups | Where-Object { $_.Key -eq $key }
    if ($existing) { $existing.Members += $member; continue }
    if (-not $display) {
      if ($npmPkg) { $display = 'npm install -g ' + $npmPkg }
      elseif ($pipPkg) { $display = 'python -m pip install --user --upgrade ' + $pipPkg }
    }
    $groups += [pscustomobject]@{
      Key = $key; Binary = $binary; Display = $display
      InstallCommand = $installCmd; NpmPackage = $npmPkg; PipPackage = $pipPkg
      Members = @($member); Installed = $false
    }
  }
  foreach ($group in $groups) {
    $labels = @($group.Members | ForEach-Object { $_.Label })
    if ($labels.Count -le 2) { $label = $labels -join ' + ' }
    else { $label = $labels[0] + ' + ' + ($labels.Count - 1) + ' more seats' }
    $group | Add-Member -NotePropertyName Label -NotePropertyValue $label
  }
  return $groups
}

function Update-ProviderGroupState {
  param($Groups)
  Add-UserToolPath
  foreach ($group in $Groups) {
    $group.Installed = [bool]($group.Binary -and (Get-Command $group.Binary -ErrorAction SilentlyContinue))
  }
}

function Invoke-ProviderInstall {
  param($Group)
  Write-Host ("[RelayBridge] Installing {0}: {1}" -f $Group.Label, $Group.Display) -ForegroundColor Cyan
  $global:LASTEXITCODE = 0
  try {
    if ($Group.InstallCommand.Count -gt 0) {
      $exe = [string]$Group.InstallCommand[0]
      $args = @()
      if ($Group.InstallCommand.Count -gt 1) { $args = @($Group.InstallCommand[1..($Group.InstallCommand.Count - 1)]) }
      if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        if ($Group.NpmPackage) { & npm install -g $Group.NpmPackage }
        elseif ($Group.PipPackage) {
          $py = 'python'
          if (Get-Command py.exe -ErrorAction SilentlyContinue) { $py = 'py' }
          & $py -m pip install --user --upgrade $Group.PipPackage
        }
        else { Write-Warning ("{0} is not available to run the installer for {1}." -f $exe, $Group.Label); return $false }
      } else {
        & $exe @args
      }
    }
    elseif ($Group.NpmPackage) { & npm install -g $Group.NpmPackage }
    elseif ($Group.PipPackage) {
      $py = 'python'
      if (Get-Command py.exe -ErrorAction SilentlyContinue) { $py = 'py' }
      & $py -m pip install --user --upgrade $Group.PipPackage
    }
    else {
      $command = ($Group.Display -split '#')[0].Trim()
      if (-not $command) { return $false }
      Invoke-Expression $command
    }
  } catch {
    Write-Warning ("Install failed for {0}: {1}" -f $Group.Label, $_.Exception.Message)
    return $false
  }
  return ($LASTEXITCODE -eq 0 -or $null -eq $LASTEXITCODE)
}

function Invoke-ProviderSetup {
  param([string]$ConfigPath, [string[]]$RequestedProviders)
  $groups = @(Get-ProviderGroups -ConfigPath $ConfigPath)
  if ($groups.Count -eq 0) { return }
  Update-ProviderGroupState -Groups $groups

  $selected = @()
  if ($RequestedProviders.Count -gt 0) {
    # Scripted mode: -Providers cursor,claude  (accepts provider kinds)
    $wanted = @()
    foreach ($token in $RequestedProviders) { $wanted += ($token -split ',') }
    $wanted = @($wanted | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
    foreach ($group in $groups) {
      $kinds = @($group.Members | ForEach-Object { $_.Kind.ToLowerInvariant() })
      foreach ($kind in $kinds) {
        if ($wanted -contains $kind -and ($selected -notcontains $group)) { $selected += $group }
      }
    }
    $known = @($groups | ForEach-Object { $_.Members } | ForEach-Object { $_.Kind.ToLowerInvariant() })
    foreach ($w in $wanted) {
      if ($known -notcontains $w) { Write-Warning ("Unknown provider '{0}' in -Providers; valid names: {1}" -f $w, ($known -join ', ')) }
    }
  } else {
    # Interactive menu. Nothing installs unless the user selects it.
    Write-Host ''
    Write-Host '[RelayBridge] Optional: install the AI CLIs you plan to use.' -ForegroundColor Cyan
    Write-Host 'Each provider runs on your own subscription/login; RelayBridge only launches the CLIs.' -ForegroundColor DarkGray
    Write-Host ''
    for ($i = 0; $i -lt $groups.Count; $i++) {
      $group = $groups[$i]
      if ($group.Installed) { $mark = '[installed]    ' } else { $mark = '[not installed]' }
      Write-Host ("  {0,2}. {1} {2}" -f ($i + 1), $mark, $group.Label)
      Write-Host ("       {0}" -f $group.Display) -ForegroundColor DarkGray
    }
    Write-Host ''
    $answer = $null
    try {
      $answer = Read-Host 'Install which? (numbers like 1,3 / A = all missing / Enter = skip)'
    } catch {
      Write-Host '[RelayBridge] Non-interactive session detected; skipping provider installs. Use -Providers name1,name2 to script them.' -ForegroundColor Yellow
      return
    }
    if ($null -eq $answer -or $answer.Trim() -eq '') {
      Write-Host '[RelayBridge] Skipping provider installs. You can install any provider later from the dashboard (click its button or use Install all).' -ForegroundColor DarkGray
      return
    }
    if ($answer.Trim() -match '^[Aa]$') {
      $selected = @($groups | Where-Object { -not $_.Installed })
    } else {
      foreach ($token in ($answer -split ',')) {
        $trimmed = $token.Trim()
        if ($trimmed -match '^\d+$') {
          $index = [int]$trimmed - 1
          if ($index -ge 0 -and $index -lt $groups.Count -and ($selected -notcontains $groups[$index])) { $selected += $groups[$index] }
          else { Write-Warning ("Ignoring out-of-range selection '{0}'." -f $trimmed) }
        } elseif ($trimmed) {
          Write-Warning ("Ignoring unrecognized selection '{0}'." -f $trimmed)
        }
      }
    }
  }

  if ($selected.Count -eq 0) {
    Write-Host '[RelayBridge] No provider CLIs selected.' -ForegroundColor DarkGray
    return
  }

  foreach ($group in $selected) {
    if ($group.Installed) {
      Write-Host ("[RelayBridge] {0} is already installed; skipping." -f $group.Label) -ForegroundColor DarkGray
      continue
    }
    $ok = Invoke-ProviderInstall -Group $group
    Update-ProviderGroupState -Groups @($group)
    if ($group.Installed) {
      Write-Host ("[RelayBridge] {0} installed." -f $group.Label) -ForegroundColor Green
    } elseif ($ok) {
      Write-Host ("[RelayBridge] {0} installer finished, but '{1}' is not on PATH yet. Open a fresh PowerShell to pick it up." -f $group.Label, $group.Binary) -ForegroundColor Yellow
    } else {
      Write-Warning ("{0} did not install cleanly. Run manually: {1}" -f $group.Label, $group.Display)
    }
    foreach ($member in $group.Members) {
      if ($member.PostInstall) { Write-Host ("       {0}: {1}" -f $member.Label, $member.PostInstall) -ForegroundColor DarkGray }
    }
  }
  Write-Host '[RelayBridge] Sign-in happens in each CLI on first use; RelayBridge never stores those credentials.' -ForegroundColor DarkGray
}

# ---------- Core install ----------

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

  if (-not $SkipProviderSetup) {
    try {
      Invoke-ProviderSetup -ConfigPath (Join-Path $InstallDir 'cli-config.json') -RequestedProviders $Providers
    } catch {
      Write-Warning ("Provider CLI setup skipped: {0}" -f $_.Exception.Message)
    }
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

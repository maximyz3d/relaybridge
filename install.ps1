[CmdletBinding()]
param(
  [string]$Repo = 'maximyz3d/relaybridge',
  [string]$Branch = 'main',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'RelayBridge'),
  [switch]$NoStart,
  [switch]$NoBrowser,
  [switch]$RegisterMcp,
  [string[]]$Providers = @(),
  [switch]$SkipProviderSetup,
  [switch]$SkipCliPathRegistration,
  [ValidateRange(1, 65535)]
  [int]$Port = 8787,
  [string]$SourceDir = '',
  [string]$MigrateFrom = ''
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
    (Join-Path $env:LOCALAPPDATA 'cursor-agent'),
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
  $config = [IO.File]::ReadAllText($ConfigPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
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

# ---------- Transactional release helpers ----------

function Get-NormalizedPath([string]$PathValue) {
  return [IO.Path]::GetFullPath($PathValue).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Test-SamePath([string]$Left, [string]$Right) {
  if (-not $Left -or -not $Right) { return $false }
  return [string]::Equals((Get-NormalizedPath $Left), (Get-NormalizedPath $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose(); $stream.Dispose() }
}

function Merge-JsonDefaults($Defaults, $Existing) {
  if ($null -eq $Existing) { return $Defaults }
  if ($Existing -is [Array]) { return ,$Existing }
  $defaultObject = $Defaults -is [pscustomobject]
  $existingObject = $Existing -is [pscustomobject]
  if (-not ($defaultObject -and $existingObject)) { return $Existing }

  $merged = [ordered]@{}
  foreach ($prop in $Defaults.PSObject.Properties) {
    $existingProp = $Existing.PSObject.Properties[$prop.Name]
    if ($existingProp) { $merged[$prop.Name] = Merge-JsonDefaults $prop.Value $existingProp.Value }
    else { $merged[$prop.Name] = $prop.Value }
  }
  foreach ($prop in $Existing.PSObject.Properties) {
    if (-not $merged.Contains($prop.Name)) { $merged[$prop.Name] = $prop.Value }
  }
  return [pscustomobject]$merged
}

# Model pins are vendor lineup FACTS, not operator preferences. Preserving the
# installed copy of `model_tiers` means a pin that shipped, was retired by the
# vendor, and was corrected in a new release gets overwritten by the stale
# installed value on every upgrade - so the upgrade cannot fix it and every
# call to that seat fails with model-not-found.
#
# So the shipped pins win by default. An operator who has deliberately chosen
# their own pins keeps them by setting "model_tiers_locked": true on the entry
# (or "_models": { "pinsLocked": true } globally). Replacements are always
# reported - silently overwriting operator config would be its own bug.
function Restore-ShippedModelPins($Merged, $Defaults, $Existing) {
  if (-not ($Merged -is [pscustomobject]) -or -not ($Defaults -is [pscustomobject])) { return $Merged }
  $globalLock = $false
  $modelsProp = $Existing.PSObject.Properties['_models']
  if ($modelsProp -and $modelsProp.Value -is [pscustomobject]) {
    $lockProp = $modelsProp.Value.PSObject.Properties['pinsLocked']
    if ($lockProp -and $lockProp.Value) { $globalLock = $true }
  }
  if ($globalLock) {
    Write-Host '[RelayBridge] _models.pinsLocked is set; keeping operator model pins as-is.'
    return $Merged
  }

  foreach ($prop in $Defaults.PSObject.Properties) {
    $name = $prop.Name
    if ($name.StartsWith('_')) { continue }
    $shipped = $prop.Value
    if (-not ($shipped -is [pscustomobject])) { continue }

    $mergedEntry = $Merged.PSObject.Properties[$name]
    if (-not $mergedEntry -or -not ($mergedEntry.Value -is [pscustomobject])) { continue }

    # Only a lock that existed in the operator's installed config is an
    # operator choice. A shipped lock added by this upgrade (Cursor's Auto-only
    # plan) must not preserve stale tiers resurrected by Merge-JsonDefaults.
    $operatorEntryLock = $false
    $existingEntry = $Existing.PSObject.Properties[$name]
    if ($existingEntry -and $existingEntry.Value -is [pscustomobject]) {
      $existingLock = $existingEntry.Value.PSObject.Properties['model_tiers_locked']
      if ($existingLock -and $existingLock.Value) { $operatorEntryLock = $true }
    }

    $existingTiers = if ($existingEntry -and $existingEntry.Value -is [pscustomobject]) {
      $existingEntry.Value.PSObject.Properties['model_tiers']
    } else { $null }
    $retiredPins = $shipped.PSObject.Properties['retired_model_pins']
    $onlyKnownRetiredPins = $false
    if ($existingTiers -and $existingTiers.Value -is [pscustomobject] -and $retiredPins) {
      $existingModels = @($existingTiers.Value.PSObject.Properties | ForEach-Object {
        $modelProp = $_.Value.PSObject.Properties['model']
        if ($modelProp -and $modelProp.Value) { [string]$modelProp.Value }
      })
      if ($existingModels.Count -gt 0) {
        $knownRetired = @($retiredPins.Value | ForEach-Object { ([string]$_).ToLowerInvariant() })
        $onlyKnownRetiredPins = -not @($existingModels | Where-Object { $knownRetired -notcontains $_.ToLowerInvariant() }).Count
      }
    }
    $mode = $shipped.PSObject.Properties['model_tiers_mode']
    $requiresAccountDefault = $mode -and ([string]$mode.Value -ieq 'account_default')

    if ($operatorEntryLock -and -not ($requiresAccountDefault -and $onlyKnownRetiredPins)) {
      Write-Host ("[RelayBridge] {0}: model_tiers_locked is set; keeping operator pins." -f $name)
      continue
    }

    $shippedTiers = $shipped.PSObject.Properties['model_tiers']
    if (-not $shippedTiers) {
      $mergedTiers = $mergedEntry.Value.PSObject.Properties['model_tiers']
      if ($requiresAccountDefault -and $mergedTiers) {
        $mergedEntry.Value.PSObject.Properties.Remove('model_tiers')
        Write-Host ("[RelayBridge] {0}: removed installed model pins because the shipped seat now requires its account default." -f $name)
      }
      if ($requiresAccountDefault -and $onlyKnownRetiredPins) {
        # PR #40's draft briefly shipped model_tiers_locked beside the stale
        # defaults. It was release metadata, not an operator decision.
        $mergedEntry.Value.PSObject.Properties.Remove('model_tiers_locked')
      }
      continue
    }

    $currentJson = ($mergedEntry.Value.PSObject.Properties['model_tiers'].Value | ConvertTo-Json -Depth 20 -Compress)
    $shippedJson = ($shippedTiers.Value | ConvertTo-Json -Depth 20 -Compress)
    if ($currentJson -ne $shippedJson) {
      $mergedEntry.Value.PSObject.Properties.Remove('model_tiers')
      $mergedEntry.Value | Add-Member -NotePropertyName 'model_tiers' -NotePropertyValue $shippedTiers.Value -Force
      Write-Host ("[RelayBridge] {0}: replaced installed model pins with the shipped set (set model_tiers_locked to keep yours)." -f $name)
    }
  }
  return $Merged
}

# Provider launch arrays are normally preserved atomically so operator model
# choices, wrapper arguments, and local policy survive an upgrade. A small
# subset of arguments is nevertheless part of RelayBridge's safety contract:
# for example, baseline Claude effort must not remain at a legacy `max` after
# maximum effort becomes an explicit per-run opt-in. The shipped config names
# those flag/value slices under `_config_merge.managed_provider_args`.
#
# Refresh only those declared slices. Never replace a whole launch array, add a
# missing flag to an operator-authored command, or touch an undeclared/unknown
# provider. This keeps the migration schema-aware and narrowly reversible.
function Restore-ShippedManagedProviderArgs($Merged, $Defaults) {
  if (-not ($Merged -is [pscustomobject]) -or -not ($Defaults -is [pscustomobject])) { return $Merged }
  $mergeSchema = $Defaults.PSObject.Properties['_config_merge']
  if (-not $mergeSchema -or -not ($mergeSchema.Value -is [pscustomobject])) { return $Merged }
  $managedProviders = $mergeSchema.Value.PSObject.Properties['managed_provider_args']
  if (-not $managedProviders -or -not ($managedProviders.Value -is [pscustomobject])) { return $Merged }

  foreach ($providerSpec in $managedProviders.Value.PSObject.Properties) {
    $providerName = $providerSpec.Name
    $spec = $providerSpec.Value
    if (-not ($spec -is [pscustomobject])) { throw "Invalid managed-provider schema for '$providerName'." }
    $defaultProvider = $Defaults.PSObject.Properties[$providerName]
    $mergedProvider = $Merged.PSObject.Properties[$providerName]
    if (-not $defaultProvider -or -not $mergedProvider -or
        -not ($defaultProvider.Value -is [pscustomobject]) -or
        -not ($mergedProvider.Value -is [pscustomobject])) { continue }

    $slotProp = $spec.PSObject.Properties['slots']
    $argsProp = $spec.PSObject.Properties['args']
    if (-not $slotProp -or -not $argsProp) { throw "Managed-provider schema for '$providerName' requires slots and args." }
    foreach ($slotNameValue in @($slotProp.Value)) {
      $slotName = [string]$slotNameValue
      $defaultSlot = $defaultProvider.Value.PSObject.Properties[$slotName]
      $mergedSlot = $mergedProvider.Value.PSObject.Properties[$slotName]
      if (-not $defaultSlot -or -not $mergedSlot) { continue }
      $shippedArgs = @($defaultSlot.Value)
      $candidateArgs = @($mergedSlot.Value)
      $changed = $false

      foreach ($argSpec in @($argsProp.Value)) {
        if (-not ($argSpec -is [pscustomobject])) { throw "Invalid managed argument schema for '$providerName.$slotName'." }
        $flagProp = $argSpec.PSObject.Properties['flag']
        $countProp = $argSpec.PSObject.Properties['value_count']
        $flag = if ($flagProp) { [string]$flagProp.Value } else { '' }
        $valueCount = if ($countProp) { [int]$countProp.Value } else { -1 }
        if (-not $flag.StartsWith('--') -or $valueCount -lt 0) {
          throw "Invalid managed argument declaration for '$providerName.$slotName'."
        }

        $shippedIndex = -1
        $candidateIndex = -1
        for ($i = 0; $i -lt $shippedArgs.Count; $i++) {
          if ([string]$shippedArgs[$i] -ceq $flag) { $shippedIndex = $i; break }
        }
        for ($i = 0; $i -lt $candidateArgs.Count; $i++) {
          if ([string]$candidateArgs[$i] -ceq $flag) { $candidateIndex = $i; break }
        }
        if ($shippedIndex -lt 0) { throw "Shipped slot '$providerName.$slotName' is missing managed flag '$flag'." }
        # A missing managed flag identifies a genuinely custom command shape.
        # Preserve it instead of guessing where a release argument belongs.
        if ($candidateIndex -lt 0) { continue }
        if (($shippedIndex + $valueCount) -ge $shippedArgs.Count -or
            ($candidateIndex + $valueCount) -ge $candidateArgs.Count) {
          throw "Managed flag '$flag' has too few values in '$providerName.$slotName'."
        }
        for ($offset = 1; $offset -le $valueCount; $offset++) {
          if ([string]$candidateArgs[$candidateIndex + $offset] -cne [string]$shippedArgs[$shippedIndex + $offset]) {
            $candidateArgs[$candidateIndex + $offset] = $shippedArgs[$shippedIndex + $offset]
            $changed = $true
          }
        }
      }

      if ($changed) {
        $mergedProvider.Value.PSObject.Properties.Remove($slotName)
        $mergedProvider.Value | Add-Member -NotePropertyName $slotName -NotePropertyValue $candidateArgs -Force
        Write-Host ("[RelayBridge] {0}.{1}: refreshed release-managed provider arguments." -f $providerName, $slotName)
      }
    }
  }
  return $Merged
}

# Compare JSON arrays without PowerShell's scalar/array coercions. Credential
# marker lists and login argv are security boundaries: an extra marker or
# different casing identifies an operator-authored value, not a retired shipped
# default that an upgrade may replace.
function Test-ExactJsonStringArray($Candidate, $Expected) {
  $candidateValues = @($Candidate)
  $expectedValues = @($Expected)
  if ($candidateValues.Count -ne $expectedValues.Count) { return $false }
  for ($i = 0; $i -lt $candidateValues.Count; $i++) {
    if (-not ($candidateValues[$i] -is [string]) -or
        -not ($expectedValues[$i] -is [string]) -or
        [string]$candidateValues[$i] -cne [string]$expectedValues[$i]) { return $false }
  }
  return $true
}

# A provider CLI's real credential-home contract is release metadata, but the
# ordinary defaults merge intentionally preserves installed values. Correct a
# previously shipped bad contract only when the installed fields equal a
# declared retired shape. The first released Copilot declaration had the bad
# environment variable and no marker field; a later candidate paired it with a
# GitHub CLI marker. A custom environment variable, marker list, or partially
# edited pair remains operator-owned.
function Restore-ShippedCredentialRelocation($Merged, $Defaults, $Existing) {
  if (-not ($Merged -is [pscustomobject]) -or
      -not ($Defaults -is [pscustomobject]) -or
      -not ($Existing -is [pscustomobject])) { return $Merged }
  $mergeSchema = $Defaults.PSObject.Properties['_config_merge']
  if (-not $mergeSchema -or -not ($mergeSchema.Value -is [pscustomobject])) { return $Merged }
  $managed = $mergeSchema.Value.PSObject.Properties['managed_credential_relocations']
  if (-not $managed -or -not ($managed.Value -is [pscustomobject])) { return $Merged }

  foreach ($providerSpec in $managed.Value.PSObject.Properties) {
    $providerName = $providerSpec.Name
    $spec = $providerSpec.Value
    if (-not ($spec -is [pscustomobject])) { throw "Invalid managed credential relocation schema for '$providerName'." }
    $retired = $spec.PSObject.Properties['retired_pair']
    $retiredWithoutMarkers = $spec.PSObject.Properties['retired_env_without_markers']
    if (-not $retired -or -not ($retired.Value -is [pscustomobject]) -or
        -not $retiredWithoutMarkers -or -not ($retiredWithoutMarkers.Value -is [string])) {
      throw "Managed credential relocation '$providerName' requires retired_pair and retired_env_without_markers."
    }
    $providers = @{}
    foreach ($source in @(@{ Key = 'default'; Root = $Defaults }, @{ Key = 'merged'; Root = $Merged }, @{ Key = 'existing'; Root = $Existing })) {
      $entry = $source.Root.PSObject.Properties[$providerName]
      if ($entry -and $entry.Value -is [pscustomobject]) { $providers[$source.Key] = $entry.Value }
    }
    if (-not $providers.ContainsKey('default')) {
      throw "Managed credential relocation '$providerName' has no shipped provider object."
    }
    if (-not $providers.ContainsKey('merged') -or -not $providers.ContainsKey('existing')) { continue }

    $defaultEnv = $providers['default'].PSObject.Properties['credential_env']
    $defaultMarkers = $providers['default'].PSObject.Properties['credential_markers']
    $retiredEnv = $retired.Value.PSObject.Properties['credential_env']
    $retiredMarkers = $retired.Value.PSObject.Properties['credential_markers']
    if (-not $defaultEnv -or -not ($defaultEnv.Value -is [string]) -or
        -not $defaultMarkers -or -not $retiredEnv -or -not ($retiredEnv.Value -is [string]) -or
        -not $retiredMarkers) {
      throw "Managed credential relocation '$providerName' requires shipped and retired credential_env/credential_markers values."
    }
    if ([string]$defaultEnv.Value -ceq [string]$retiredEnv.Value -and
        (Test-ExactJsonStringArray $defaultMarkers.Value $retiredMarkers.Value)) {
      throw "Managed credential relocation '$providerName' retires the pair it still ships."
    }

    $existingEnv = $providers['existing'].PSObject.Properties['credential_env']
    $existingMarkers = $providers['existing'].PSObject.Properties['credential_markers']
    if (-not $existingEnv -or -not ($existingEnv.Value -is [string])) { continue }
    $matchesRetiredPair = $existingMarkers -and
      [string]$existingEnv.Value -ceq [string]$retiredEnv.Value -and
      (Test-ExactJsonStringArray $existingMarkers.Value $retiredMarkers.Value)
    $matchesReleasedShape = -not $existingMarkers -and
      [string]$existingEnv.Value -ceq [string]$retiredWithoutMarkers.Value
    if (-not $matchesRetiredPair -and -not $matchesReleasedShape) { continue }

    if ($providers['merged'].PSObject.Properties['credential_env']) {
      $providers['merged'].credential_env = $defaultEnv.Value
    } else {
      $providers['merged'] | Add-Member -NotePropertyName 'credential_env' -NotePropertyValue $defaultEnv.Value -Force
    }
    if ($providers['merged'].PSObject.Properties['credential_markers']) {
      $providers['merged'].credential_markers = @($defaultMarkers.Value)
    } else {
      $providers['merged'] | Add-Member -NotePropertyName 'credential_markers' -NotePropertyValue @($defaultMarkers.Value) -Force
    }
    Write-Host ("[RelayBridge] {0}: replaced the retired shipped credential relocation {1}/{2} with {3}/{4}." -f `
      $providerName, $retiredEnv.Value, (@($retiredMarkers.Value) -join ','),
      $defaultEnv.Value, (@($defaultMarkers.Value) -join ','))
  }
  return $Merged
}

# Login commands are also preserved by the ordinary merge. Refresh one only
# when the installed argv is byte-for-byte the retired shipped command; a
# wrapper or any operator edit stays untouched.
function Restore-ShippedManagedLoginCommands($Merged, $Defaults, $Existing) {
  if (-not ($Merged -is [pscustomobject]) -or
      -not ($Defaults -is [pscustomobject]) -or
      -not ($Existing -is [pscustomobject])) { return $Merged }
  $mergeSchema = $Defaults.PSObject.Properties['_config_merge']
  if (-not $mergeSchema -or -not ($mergeSchema.Value -is [pscustomobject])) { return $Merged }
  $managed = $mergeSchema.Value.PSObject.Properties['managed_login_commands']
  if (-not $managed -or -not ($managed.Value -is [pscustomobject])) { return $Merged }

  foreach ($providerSpec in $managed.Value.PSObject.Properties) {
    $providerName = $providerSpec.Name
    $spec = $providerSpec.Value
    if (-not ($spec -is [pscustomobject])) { throw "Invalid managed login-command schema for '$providerName'." }
    $retired = $spec.PSObject.Properties['retired_command']
    $defaultProvider = $Defaults.PSObject.Properties[$providerName]
    $mergedProvider = $Merged.PSObject.Properties[$providerName]
    $existingProvider = $Existing.PSObject.Properties[$providerName]
    if (-not $retired -or -not $defaultProvider -or -not ($defaultProvider.Value -is [pscustomobject])) {
      throw "Managed login command '$providerName' requires retired_command and a shipped provider object."
    }
    if (-not $mergedProvider -or -not ($mergedProvider.Value -is [pscustomobject]) -or
        -not $existingProvider -or -not ($existingProvider.Value -is [pscustomobject])) { continue }
    $shipped = $defaultProvider.Value.PSObject.Properties['login_command']
    $installed = $existingProvider.Value.PSObject.Properties['login_command']
    if (-not $shipped) { throw "Managed login command '$providerName' has no shipped login_command." }
    if (Test-ExactJsonStringArray $shipped.Value $retired.Value) {
      throw "Managed login command '$providerName' retires the command it still ships."
    }
    if (-not $installed -or -not (Test-ExactJsonStringArray $installed.Value $retired.Value)) { continue }
    $mergedProvider.Value.login_command = @($shipped.Value)
    Write-Host ("[RelayBridge] {0}: replaced the retired shipped login command '{1}' with '{2}'." -f `
      $providerName, (@($retired.Value) -join ' '), (@($shipped.Value) -join ' '))
  }
  return $Merged
}

# Token and alternate-provider environment variables can override a relocated
# credential directory and make one account pay while another is recorded.
# For the explicitly managed providers, shipped strip_env entries are therefore
# minimum safety policy rather than replaceable defaults. Preserve the
# operator's order and extra exclusions, appending only missing required names.
function Restore-ShippedRequiredStripEnv($Merged, $Defaults) {
  if (-not ($Merged -is [pscustomobject]) -or -not ($Defaults -is [pscustomobject])) { return $Merged }
  $mergeSchema = $Defaults.PSObject.Properties['_config_merge']
  if (-not $mergeSchema -or -not ($mergeSchema.Value -is [pscustomobject])) { return $Merged }
  $managed = $mergeSchema.Value.PSObject.Properties['managed_required_strip_env']
  if (-not $managed) { return $Merged }
  $managedProviders = @($managed.Value)
  if (-not $managedProviders.Count) { throw 'managed_required_strip_env must name at least one provider.' }

  foreach ($providerNameValue in $managedProviders) {
    if (-not ($providerNameValue -is [string]) -or -not [string]$providerNameValue) {
      throw 'managed_required_strip_env contains an invalid provider name.'
    }
    $providerName = [string]$providerNameValue
    $defaultProvider = $Defaults.PSObject.Properties[$providerName]
    $mergedProvider = $Merged.PSObject.Properties[$providerName]
    if (-not $defaultProvider -or -not ($defaultProvider.Value -is [pscustomobject])) {
      throw "Managed strip_env provider '$providerName' has no shipped provider object."
    }
    if (-not $mergedProvider -or -not ($mergedProvider.Value -is [pscustomobject])) { continue }
    $requiredProp = $defaultProvider.Value.PSObject.Properties['strip_env']
    if (-not $requiredProp) { throw "Managed strip_env provider '$providerName' has no shipped strip_env." }
    $required = @($requiredProp.Value)
    $invalidRequired = @($required | Where-Object {
      -not ($_ -is [string]) -or $_ -notmatch '^[A-Z][A-Z0-9_]*$'
    })
    if (-not $required.Count -or $invalidRequired.Count) {
      throw "Managed strip_env provider '$providerName' has an invalid shipped strip_env."
    }

    $installedProp = $mergedProvider.Value.PSObject.Properties['strip_env']
    $installed = if ($installedProp) { @($installedProp.Value) } else { @() }
    $invalidInstalled = @($installed | Where-Object {
      -not ($_ -is [string]) -or $_ -notmatch '^[A-Za-z_][A-Za-z0-9_]*$'
    })
    if ($invalidInstalled.Count) {
      throw "Installed strip_env for '$providerName' is not an array of environment names."
    }
    $seen = @{}
    foreach ($name in $installed) { $seen[[string]$name.ToUpperInvariant()] = $true }
    $changed = $false
    foreach ($name in $required) {
      $key = [string]$name.ToUpperInvariant()
      if ($seen.ContainsKey($key)) { continue }
      $installed += [string]$name
      $seen[$key] = $true
      $changed = $true
    }
    if (-not $changed -and $installedProp) { continue }
    if ($installedProp) { $mergedProvider.Value.strip_env = $installed }
    else { $mergedProvider.Value | Add-Member -NotePropertyName 'strip_env' -NotePropertyValue $installed -Force }
    if ($changed) {
      Write-Host ("[RelayBridge] {0}: added required credential-identity environment exclusions." -f $providerName)
    }
  }
  return $Merged
}

# JSON numbers survive ConvertFrom-Json as Int32/Int64/Decimal/Double depending
# on the literal, so a retired default written as 24 must still match an
# installed 24 read back as any of those. PowerShell's -contains would go
# further and coerce the string "24", or a boolean into 1; that would silently
# rewrite a value this release never shipped. Compare numerically, and only
# after both sides are confirmed to be one of the numeric types JSON can
# produce - "is a ValueType" would also admit the DateTime that
# ConvertFrom-Json makes out of a date-like string, whose [double] cast throws.
function Test-RetiredJsonNumber($Candidate, $Retired) {
  $numericTypes = @([byte], [int16], [int32], [int64], [single], [double], [decimal])
  foreach ($value in @($Candidate, $Retired)) {
    if ($null -eq $value -or $value -is [bool] -or $numericTypes -notcontains $value.GetType()) { return $false }
  }
  return ([double]$Candidate -eq [double]$Retired)
}

function Format-JsonScalar($Value) {
  if ($null -eq $Value) { return 'null' }
  return [string]$Value
}

# Some supervisor ceilings are release policy rather than operator taste, and a
# shipped default that turns out to be wrong cannot be corrected by an upgrade
# while the installed copy keeps winning the merge. Provider turn counts are
# the case in point: an agentic CLI spends one turn per tool call, so a healthy
# Claude run reports a terminal num_turns far above any small ceiling while
# staying well inside every token ceiling, and the shipped cap killed complete,
# successful results.
#
# The migration stays deliberately narrow. A field is rewritten only when the
# installed value is exactly one of the retired shipped defaults declared in
# `_config_merge.managed_supervisor_budget_fields`. Any other installed value -
# including one an operator chose after the retired default shipped - is
# preserved, and every replacement is reported with both values so it can be
# put back. Only the global `_supervisor.providerBudget` is in scope. Shipped
# provider/task-tier defaults are added by the normal deep merge when missing;
# existing provider-specific values remain operator-owned. Retiring a shipped
# provider/task-tier value would require an explicit managed migration schema
# rather than silently broadening this global-only migration.
function Restore-ShippedManagedSupervisorBudget($Merged, $Defaults, $Existing) {
  if (-not ($Merged -is [pscustomobject]) -or
      -not ($Defaults -is [pscustomobject]) -or
      -not ($Existing -is [pscustomobject])) { return $Merged }
  $mergeSchema = $Defaults.PSObject.Properties['_config_merge']
  if (-not $mergeSchema -or -not ($mergeSchema.Value -is [pscustomobject])) { return $Merged }
  $managed = $mergeSchema.Value.PSObject.Properties['managed_supervisor_budget_fields']
  if (-not $managed -or -not ($managed.Value -is [pscustomobject])) { return $Merged }

  $budgets = @{}
  foreach ($source in @(@{ Key = 'default'; Root = $Defaults }, @{ Key = 'merged'; Root = $Merged }, @{ Key = 'existing'; Root = $Existing })) {
    $supervisor = $source.Root.PSObject.Properties['_supervisor']
    if (-not $supervisor -or -not ($supervisor.Value -is [pscustomobject])) { continue }
    $budget = $supervisor.Value.PSObject.Properties['providerBudget']
    if (-not $budget -or -not ($budget.Value -is [pscustomobject])) { continue }
    $budgets[$source.Key] = $budget.Value
  }
  # A release that declares managed budget fields must ship them.
  if (-not $budgets.ContainsKey('default')) {
    throw 'Shipped cli-config.json declares managed supervisor budget fields but has no _supervisor.providerBudget object.'
  }
  # No installed block, or an operator who replaced it with something that is
  # not an object: nothing to migrate. The merge already supplied the default.
  if (-not $budgets.ContainsKey('merged') -or -not $budgets.ContainsKey('existing')) { return $Merged }
  $defaultBudget = $budgets['default']
  $mergedBudget = $budgets['merged']
  $existingBudget = $budgets['existing']

  foreach ($fieldSpec in $managed.Value.PSObject.Properties) {
    $fieldName = $fieldSpec.Name
    if (-not ($fieldSpec.Value -is [pscustomobject])) {
      throw "Invalid managed supervisor budget schema for '$fieldName'."
    }
    $retiredProp = $fieldSpec.Value.PSObject.Properties['retired_values']
    $defaultField = $defaultBudget.PSObject.Properties[$fieldName]
    if (-not $retiredProp -or -not $defaultField) {
      throw "Managed supervisor budget field '$fieldName' requires retired_values and a shipped default."
    }
    $retiredValues = @($retiredProp.Value)
    if ($retiredValues.Count -lt 1) {
      throw "Managed supervisor budget field '$fieldName' declares no retired values."
    }
    foreach ($retired in $retiredValues) {
      # A supported number is the only thing that matches itself, so this is
      # the same admissibility test the comparison below will apply.
      if (-not (Test-RetiredJsonNumber $retired $retired)) {
        throw "Managed supervisor budget field '$fieldName' declares a non-numeric retired value."
      }
      # Retiring the value still being shipped would rewrite every install to
      # the number this migration exists to remove.
      if (Test-RetiredJsonNumber $defaultField.Value $retired) {
        throw "Managed supervisor budget field '$fieldName' retires the value it still ships as its default."
      }
    }

    $existingField = $existingBudget.PSObject.Properties[$fieldName]
    if (-not $existingField) { continue }
    $isRetired = $false
    foreach ($retired in $retiredValues) {
      if (Test-RetiredJsonNumber $existingField.Value $retired) { $isRetired = $true; break }
    }
    if (-not $isRetired) { continue }

    # Assign in place rather than remove-and-re-add: rewriting the property
    # would move it to the end of the object and reorder the operator's file
    # for a value change.
    if ($mergedBudget.PSObject.Properties[$fieldName]) { $mergedBudget.$fieldName = $defaultField.Value }
    else { $mergedBudget | Add-Member -NotePropertyName $fieldName -NotePropertyValue $defaultField.Value -Force }
    Write-Host ("[RelayBridge] _supervisor.providerBudget.{0}: replaced retired shipped value {1} with this release's default {2} (set your own value to override)." -f `
      $fieldName, (Format-JsonScalar $existingField.Value), (Format-JsonScalar $defaultField.Value))
  }
  return $Merged
}

function Merge-JsonFile([string]$DefaultPath, [string]$ExistingPath) {
  if (-not (Test-Path -LiteralPath $ExistingPath -PathType Leaf)) { return }
  if (-not (Test-Path -LiteralPath $DefaultPath -PathType Leaf)) {
    $parent = Split-Path -Parent $DefaultPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $ExistingPath -Destination $DefaultPath -Force
    return
  }
  try {
    $defaults = [IO.File]::ReadAllText($DefaultPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    $existing = [IO.File]::ReadAllText($ExistingPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  } catch {
    throw "Cannot safely preserve operator JSON '$ExistingPath': $($_.Exception.Message)"
  }
  $merged = Merge-JsonDefaults $defaults $existing
  if ([IO.Path]::GetFileName($DefaultPath) -ieq 'cli-config.json') {
    $merged = Restore-ShippedModelPins $merged $defaults $existing
    $merged = Restore-ShippedManagedProviderArgs $merged $defaults
    $merged = Restore-ShippedCredentialRelocation $merged $defaults $existing
    $merged = Restore-ShippedManagedLoginCommands $merged $defaults $existing
    $merged = Restore-ShippedRequiredStripEnv $merged $defaults
    $merged = Restore-ShippedManagedSupervisorBudget $merged $defaults $existing
  }
  $tempPath = "$DefaultPath.merge.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($tempPath, (($merged | ConvertTo-Json -Depth 100) + "`n"), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempPath -Destination $DefaultPath -Force
  } finally {
    if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue }
  }
}

function Merge-OperatorConfiguration([string]$StageRoot, [string]$ExistingRoot) {
  if (-not $ExistingRoot -or -not (Test-Path -LiteralPath $ExistingRoot -PathType Container)) { return }
  Merge-JsonFile (Join-Path $StageRoot 'cli-config.json') (Join-Path $ExistingRoot 'cli-config.json')
  $existingConfig = Join-Path $ExistingRoot 'config'
  if (-not (Test-Path -LiteralPath $existingConfig -PathType Container)) { return }
  Get-ChildItem -LiteralPath $existingConfig -File -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($existingConfig.Length).TrimStart('\', '/')
    $target = Join-Path (Join-Path $StageRoot 'config') $relative
    if ($_.Extension -ieq '.json') { Merge-JsonFile $target $_.FullName }
    elseif (-not (Test-Path -LiteralPath $target)) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
  }
}

function Copy-ReleaseSource([string]$SourceRoot, [string]$StageRoot) {
  $excluded = @('.git', 'node_modules', '.bridge-token', '.state.json', '.mcp-start.lock', 'data', 'migration-backups', 'build-info.json')
  New-Item -ItemType Directory -Path $StageRoot -Force | Out-Null
  Get-ChildItem -LiteralPath $SourceRoot -Force | ForEach-Object {
    if ($excluded -contains $_.Name) { return }
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $StageRoot $_.Name) -Recurse -Force
  }
}

function Get-ReleaseBuildInfo([string]$StageRoot, [string]$SourceLabel) {
  $package = [IO.File]::ReadAllText((Join-Path $StageRoot 'package.json'), [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  $excludedTopLevel = @('node_modules', 'data', 'migration-backups')
  $parts = @()
  $files = @(Get-ChildItem -LiteralPath $StageRoot -File -Recurse -Force | Where-Object {
    $relative = $_.FullName.Substring($StageRoot.Length).TrimStart('\', '/')
    $topLevel = ($relative -split '[\\/]', 2)[0]
    $excludedTopLevel -notcontains $topLevel -and
      $_.Name -notin @('.bridge-token', '.state.json', '.mcp-start.lock', 'build-info.json') -and
      $_.Extension -ine '.log'
  } | Sort-Object FullName)
  if ($files.Count -eq 0) { throw 'Release contains no files to identify.' }
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($StageRoot.Length).TrimStart('\', '/').Replace('\', '/')
    $parts += ($relative + ':' + (Get-Sha256 $file.FullName))
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($parts -join ':'))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $digest = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  return [ordered]@{
    version = [string]$package.version
    buildId = ([string]$package.version + '+' + $digest.Substring(0, 16))
    source = $SourceLabel
    installedAt = [DateTime]::UtcNow.ToString('o')
  }
}

function Get-BridgeHealth([int]$BridgePort, [int]$TimeoutSec = 2) {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/api/health" -TimeoutSec $TimeoutSec -UseBasicParsing }
  catch { return $null }
}

function Test-LocalPortInUse([int]$BridgePort) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $pending = $client.BeginConnect('127.0.0.1', $BridgePort, $null, $null)
    if (-not $pending.AsyncWaitHandle.WaitOne(500)) { return $false }
    $client.EndConnect($pending)
    return $true
  } catch { return $false }
  finally { $client.Dispose() }
}

function Stop-BridgeForCutover([string]$RuntimeRoot, [int]$BridgePort) {
  $health = Get-BridgeHealth $BridgePort
  if (-not $health) {
    if (Test-LocalPortInUse $BridgePort) { throw "Port $BridgePort is occupied by a service that is not a compatible RelayBridge; cutover was not attempted." }
    return $null
  }
  if (-not $health.capabilityAuth) { throw "Port $BridgePort is serving an unrecognized RelayBridge-compatible process; cutover was not attempted." }
  $tokenPath = Join-Path $RuntimeRoot '.bridge-token'
  if (-not (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    throw "A RelayBridge is already running on port $BridgePort, but $RuntimeRoot has no capability token. Stop it explicitly or select the matching -MigrateFrom root."
  }
  $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
  if ($token -notmatch '^[A-Fa-f0-9]{64}$') { throw "The capability token in $tokenPath is invalid; cutover was not attempted." }
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$BridgePort/api/admin/shutdown" -Method Post -Headers @{ 'X-RelayBridge-Token' = $token } -ContentType 'application/json' -Body '{}' -TimeoutSec 5 -UseBasicParsing | Out-Null
  } catch {
    throw "Could not stop the RelayBridge on port $BridgePort with the token from $RuntimeRoot. This usually means another install root owns the live bridge. Cutover was not attempted."
  }
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    if (-not (Test-LocalPortInUse $BridgePort)) { return $health }
    Start-Sleep -Milliseconds 100
  }
  throw "RelayBridge on port $BridgePort did not stop before cutover."
}

function Start-StagedBridge([string]$BridgeRoot, [int]$BridgePort, [string]$ExpectedBuildId, [switch]$AllowLegacyVersion) {
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
  $stdout = Join-Path $BridgeRoot 'bridge.install.out.log'
  $stderr = Join-Path $BridgeRoot 'bridge.install.err.log'
  $previousPort = $env:PORT
  try {
    $env:PORT = [string]$BridgePort
    $proc = Start-Process -FilePath $nodePath -ArgumentList 'server.js' -WorkingDirectory $BridgeRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  } finally {
    $env:PORT = $previousPort
  }
  try {
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
      if ($proc.HasExited) { throw "RelayBridge candidate exited with code $($proc.ExitCode). See $stderr" }
      $health = Get-BridgeHealth $BridgePort
      if ($health) {
        $actualBuildId = [string]$health.buildId
        if (-not $actualBuildId -and $AllowLegacyVersion) { $actualBuildId = [string]$health.version }
        if (-not $health.capabilityAuth -or $actualBuildId -ne $ExpectedBuildId) {
          throw "Port $BridgePort reported build '$actualBuildId' instead of candidate '$ExpectedBuildId'."
        }
        if (-not $AllowLegacyVersion -and
            (-not $health.receiptStoreIdentityReady -or [string]$health.receiptStoreId -notmatch '^[0-9a-f]{64}$')) {
          throw "RelayBridge candidate $ExpectedBuildId did not initialize a valid receipt-store identity."
        }
        return [pscustomobject]@{ Process = $proc; Health = $health }
      }
      Start-Sleep -Milliseconds 100
    }
    throw "RelayBridge candidate did not become healthy on port $BridgePort. See $stderr"
  } catch {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    throw
  }
}

function Move-PreservedRuntime([string]$FromRoot, [string]$ToRoot) {
  $moved = @()
  try {
    foreach ($name in @('.bridge-token', '.state.json', 'data', 'migration-backups')) {
      $source = Join-Path $FromRoot $name
      if (-not (Test-Path -LiteralPath $source)) { continue }
      $target = Join-Path $ToRoot $name
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Move-Item -LiteralPath $source -Destination $target
      $moved += $name
    }
  } catch {
    Restore-PreservedRuntime $ToRoot $FromRoot $moved
    throw
  }
  return $moved
}

function Restore-PreservedRuntime([string]$FromRoot, [string]$ToRoot, [string[]]$Names) {
  foreach ($name in $Names) {
    $source = Join-Path $FromRoot $name
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $target = Join-Path $ToRoot $name
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    Move-Item -LiteralPath $source -Destination $target
  }
}

function Assert-NoInjectedInstallFailure([string]$Point) {
  if ($env:RELAYBRIDGE_INSTALL_TEST_FAIL_AT -and $env:RELAYBRIDGE_INSTALL_TEST_FAIL_AT -eq $Point) {
    throw "Injected installer failure at $Point"
  }
}

# ---------- Core install ----------

$InstallDir = Get-NormalizedPath $InstallDir
$installParent = Split-Path -Parent $InstallDir
$installLeaf = Split-Path -Leaf $InstallDir
if (-not $installParent -or -not $installLeaf) { throw "InstallDir must name a specific directory: $InstallDir" }
New-Item -ItemType Directory -Path $installParent -Force | Out-Null

$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("relaybridge-install-" + [Guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'source.zip'
$extractRoot = Join-Path $tempRoot 'extract'
$stageRoot = Join-Path $installParent ($installLeaf + '.stage.' + [Guid]::NewGuid().ToString('N'))
$backupRoot = Join-Path $installParent ($installLeaf + '.rollback.' + [Guid]::NewGuid().ToString('N'))
$failedRoot = Join-Path $installParent ($installLeaf + '.failed.' + [Guid]::NewGuid().ToString('N'))
$sourceRootPath = ''
$sourceLabel = ''
$runtimeSource = ''
$movedRuntime = @()
$hadExistingInstall = Test-Path -LiteralPath $InstallDir -PathType Container
$promoted = $false
$oldRenamed = $false
$oldHealth = $null
$candidate = $null
$buildInfo = $null
$preserveRecoveryArtifacts = $false

if ($MigrateFrom) {
  $MigrateFrom = Get-NormalizedPath $MigrateFrom
  if (-not (Test-Path -LiteralPath $MigrateFrom -PathType Container)) { throw "MigrateFrom is not a directory: $MigrateFrom" }
  if ($hadExistingInstall -and -not (Test-SamePath $InstallDir $MigrateFrom)) {
    throw "Both InstallDir and MigrateFrom exist. Select one source of truth and archive the other before installing; RelayBridge will not merge two live data roots automatically."
  }
}
$runtimeSource = if ($hadExistingInstall) { $InstallDir } elseif ($MigrateFrom) { $MigrateFrom } else { '' }

New-Item -ItemType Directory -Path $tempRoot, $extractRoot -Force | Out-Null
try {
  if ($SourceDir) {
    $sourceRootPath = Get-NormalizedPath $SourceDir
    if (-not (Test-Path -LiteralPath $sourceRootPath -PathType Container)) { throw "SourceDir is not a directory: $sourceRootPath" }
    $sourceLabel = "local:$sourceRootPath"
  } else {
    $zipUrl = "https://codeload.github.com/$Repo/zip/refs/heads/$Branch"
    Write-Host "[RelayBridge] Downloading $Repo@$Branch..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
    $downloadedRoot = Get-ChildItem -LiteralPath $extractRoot -Directory | Select-Object -First 1
    if (-not $downloadedRoot) { throw 'Downloaded archive did not contain a source directory.' }
    $sourceRootPath = $downloadedRoot.FullName
    $sourceLabel = "github:$Repo@$Branch"
  }

  Write-Host "[RelayBridge] Staging release beside $InstallDir..." -ForegroundColor Cyan
  Copy-ReleaseSource $sourceRootPath $stageRoot

  Push-Location -LiteralPath $stageRoot
  try {
    Write-Host '[RelayBridge] Installing locked dependencies in staging...' -ForegroundColor Cyan
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
      Write-Host '[RelayBridge] Retrying staging without the optional native PTY dependency.' -ForegroundColor Yellow
      npm ci --no-audit --no-fund --omit=optional
      if ($LASTEXITCODE -ne 0) { throw 'npm ci failed in staging' }
    }
    Write-Host '[RelayBridge] Running no-provider release tests in staging...' -ForegroundColor Cyan
    $previousSkipInstallTest = $env:RELAYBRIDGE_SKIP_INSTALL_TEST
    try {
      $env:RELAYBRIDGE_SKIP_INSTALL_TEST = '1'
      npm test
      if ($LASTEXITCODE -ne 0) { throw 'npm test failed in staging' }
    } finally {
      $env:RELAYBRIDGE_SKIP_INSTALL_TEST = $previousSkipInstallTest
    }
  } finally { Pop-Location }

  $buildInfo = Get-ReleaseBuildInfo $stageRoot $sourceLabel
  [IO.File]::WriteAllText((Join-Path $stageRoot 'build-info.json'), (($buildInfo | ConvertTo-Json -Depth 5) + "`n"), [Text.UTF8Encoding]::new($false))
  Merge-OperatorConfiguration $stageRoot $runtimeSource
  Assert-NoInjectedInstallFailure 'after-stage'

  if ($runtimeSource) {
    $oldHealth = Stop-BridgeForCutover $runtimeSource $Port
    # Capture any operator edits made while staging, after the old process has
    # drained and immediately before the atomic promotion.
    Merge-OperatorConfiguration $stageRoot $runtimeSource
    # From this point until the transaction commits, stageRoot can contain the
    # only copy of the capability token and receipt store. Preserve recovery
    # roots if PowerShell is interrupted in a way that bypasses catch.
    $preserveRecoveryArtifacts = $true
    $movedRuntime = @(Move-PreservedRuntime $runtimeSource $stageRoot)
  } elseif (Test-LocalPortInUse $Port) {
    throw "Port $Port is already occupied. A fresh RelayBridge install will not replace an unknown listener."
  }

  if ($hadExistingInstall) {
    Move-Item -LiteralPath $InstallDir -Destination $backupRoot
    $oldRenamed = $true
  }
  Assert-NoInjectedInstallFailure 'after-old-rename'
  Move-Item -LiteralPath $stageRoot -Destination $InstallDir
  $promoted = $true
  Assert-NoInjectedInstallFailure 'after-promote'

  if (-not $NoStart) {
    $candidate = Start-StagedBridge $InstallDir $Port $buildInfo.buildId
    Assert-NoInjectedInstallFailure 'after-start'
  }

  if ($RegisterMcp) {
    # install-mcp.ps1 is a PowerShell script and throws on registration or
    # verification failure.  Do not inspect a global native-process code here:
    # native probes inside the child script may legitimately leave a stale
    # non-zero native exit code even after the script has verified both MCP
    # registrations and returned normally.
    try { & (Join-Path $InstallDir 'install-mcp.ps1') }
    catch { throw "MCP registration failed: $($_.Exception.Message)" }
  }

  if (-not $SkipProviderSetup) {
    try { Invoke-ProviderSetup -ConfigPath (Join-Path $InstallDir 'cli-config.json') -RequestedProviders $Providers }
    catch { Write-Warning ("Provider CLI setup skipped after core cutover: {0}" -f $_.Exception.Message) }
  }

  if (-not $SkipCliPathRegistration) {
    $pathResult = & (Join-Path $InstallDir 'tools\register-cli-path.ps1') -InstallDir $InstallDir
    if ($pathResult.UserPathChanged) {
      Write-Host "[RelayBridge] Added $InstallDir to your user PATH. New shells can run 'relaybridge'." -ForegroundColor Green
    } else {
      Write-Host "[RelayBridge] CLI path is already registered: $InstallDir" -ForegroundColor DarkGray
    }
  }

  if (Test-Path -LiteralPath $backupRoot) {
    try { Remove-Item -LiteralPath $backupRoot -Recurse -Force }
    catch { Write-Warning "The new release is healthy, but the rollback directory could not be removed: $backupRoot" }
  }
  if ($MigrateFrom -and -not (Test-SamePath $MigrateFrom $InstallDir)) {
    Write-Host "[RelayBridge] Runtime token/data migrated from $MigrateFrom; its old code tree was left in place without the moved runtime files." -ForegroundColor Yellow
  }
  $preserveRecoveryArtifacts = $false
  Write-Host "[RelayBridge] Installed build $($buildInfo.buildId) at $InstallDir" -ForegroundColor Green
  if (-not $NoStart -and -not $NoBrowser) {
    try { Start-Process "http://127.0.0.1:$Port" }
    catch { Write-Warning "RelayBridge is healthy, but the dashboard could not be opened automatically: $($_.Exception.Message)" }
  }
} catch {
  $installError = $_
  $rollbackErrors = @()
  if ($env:RELAYBRIDGE_INSTALL_TEST_ERROR_FILE) {
    try {
      $diagnostic = @(
        $_.Exception.ToString()
        $_.ScriptStackTrace
      ) -join "`r`n"
      [IO.File]::WriteAllText($env:RELAYBRIDGE_INSTALL_TEST_ERROR_FILE, ($diagnostic + "`r`n"), [Text.UTF8Encoding]::new($false))
    } catch {
      # Test-only diagnostics must never interfere with the production rollback.
    }
  }
  Write-Warning ("RelayBridge installation failed; restoring the previous release: {0}" -f $_.Exception.Message)
  if ($candidate -and $candidate.Process -and -not $candidate.Process.HasExited) {
    Stop-Process -Id $candidate.Process.Id -Force -ErrorAction SilentlyContinue
    for ($attempt = 0; $attempt -lt 50 -and (Test-LocalPortInUse $Port); $attempt++) { Start-Sleep -Milliseconds 100 }
  }
  try {
    if ($promoted -and (Test-Path -LiteralPath $InstallDir)) {
      Move-Item -LiteralPath $InstallDir -Destination $failedRoot
      if ($hadExistingInstall -and (Test-Path -LiteralPath $backupRoot)) { Move-Item -LiteralPath $backupRoot -Destination $InstallDir }
      if ($runtimeSource -and $movedRuntime.Count -gt 0) {
        Restore-PreservedRuntime $failedRoot $runtimeSource $movedRuntime
      }
      if (Test-Path -LiteralPath $failedRoot) { Remove-Item -LiteralPath $failedRoot -Recurse -Force -ErrorAction Stop }
    } elseif (-not $promoted) {
      if ($oldRenamed -and (Test-Path -LiteralPath $backupRoot)) { Move-Item -LiteralPath $backupRoot -Destination $InstallDir }
      if ($runtimeSource -and $movedRuntime.Count -gt 0 -and (Test-Path -LiteralPath $stageRoot)) {
        Restore-PreservedRuntime $stageRoot $runtimeSource $movedRuntime
      }
    }
  } catch { $rollbackErrors += $_.Exception.Message }
  if ($rollbackErrors.Count -eq 0 -and $oldHealth -and $runtimeSource -and (Test-Path -LiteralPath (Join-Path $runtimeSource 'server.js'))) {
    try {
      $oldBuild = if ($oldHealth.buildId) { [string]$oldHealth.buildId } else { [string]$oldHealth.version }
      Start-StagedBridge $runtimeSource $Port $oldBuild -AllowLegacyVersion | Out-Null
      Write-Warning "Previous RelayBridge build $oldBuild was restored and restarted."
    } catch { $rollbackErrors += "automatic restart failed: $($_.Exception.Message)" }
  }
  if ($rollbackErrors.Count) {
    $preserveRecoveryArtifacts = $true
    Write-Warning ("Automatic rollback was incomplete; recovery directories were preserved beside the install root: " + ($rollbackErrors -join '; '))
  } else {
    $preserveRecoveryArtifacts = $false
  }
  throw $installError
} finally {
  $cleanupTargets = @($tempRoot)
  if (-not $preserveRecoveryArtifacts) {
    $cleanupTargets += @($stageRoot, $backupRoot, $failedRoot)
  } else {
    Write-Warning "RelayBridge recovery directories were preserved beside the install root. Do not delete stage/rollback/failed roots until token and data ownership are reconciled."
  }
  foreach ($cleanup in $cleanupTargets) {
    if ($cleanup -and (Test-Path -LiteralPath $cleanup)) { Remove-Item -LiteralPath $cleanup -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

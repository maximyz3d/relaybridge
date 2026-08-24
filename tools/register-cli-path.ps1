[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [switch]$NoPersist,
  [AllowEmptyString()]
  [string]$UserPath = [Environment]::GetEnvironmentVariable('Path', 'User'),
  [AllowEmptyString()]
  [string]$ProcessPath = $env:Path
)

$ErrorActionPreference = 'Stop'

function Get-ComparablePathEntry([string]$Value) {
  if (-not $Value) { return '' }
  $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
  try { $expanded = [IO.Path]::GetFullPath($expanded) } catch {}
  return $expanded.TrimEnd('\', '/')
}

function Add-PathEntry([string]$PathValue, [string]$Entry) {
  $entryComparable = Get-ComparablePathEntry $Entry
  if (-not $entryComparable) { throw 'InstallDir must resolve to a non-empty PATH entry.' }
  $entries = @($PathValue -split ';' | Where-Object { $_ -and $_.Trim() })
  foreach ($existing in $entries) {
    if ([string]::Equals((Get-ComparablePathEntry $existing), $entryComparable, [StringComparison]::OrdinalIgnoreCase)) {
      return ($entries -join ';')
    }
  }
  return (@($entries) + $Entry) -join ';'
}

$normalizedInstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\', '/')
$mergedUserPath = Add-PathEntry $UserPath $normalizedInstallDir
$mergedProcessPath = Add-PathEntry $ProcessPath $normalizedInstallDir

if (-not $NoPersist) {
  if ($mergedUserPath -ne $UserPath) {
    [Environment]::SetEnvironmentVariable('Path', $mergedUserPath, 'User')
  }
  $env:Path = $mergedProcessPath
}

[pscustomobject]@{
  InstallDir = $normalizedInstallDir
  UserPath = $mergedUserPath
  ProcessPath = $mergedProcessPath
  UserPathChanged = ($mergedUserPath -ne $UserPath)
  ProcessPathChanged = ($mergedProcessPath -ne $ProcessPath)
}

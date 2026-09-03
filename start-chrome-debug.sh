#!/usr/bin/env bash

# Launch a dedicated Google Chrome debugging profile for WSL-native MCP clients.
set -euo pipefail

fail() {
  printf '[RelayBridge] %s\n' "$*" >&2
  exit 1
}

PORT="${RELAYBRIDGE_CHROME_PORT:-9222}"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || \
  fail 'RELAYBRIDGE_CHROME_PORT must be 1-65535.'

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
is_wsl=0
if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; then
  is_wsl=1
fi

if (( is_wsl )); then
  case "$script_dir" in
    /mnt|/mnt/*) fail 'move RelayBridge under the WSL Linux filesystem before launching Chrome' ;;
  esac
fi

curl_bin="$(type -P curl || true)"
[[ -n "$curl_bin" ]] || fail 'Linux-native curl is required to verify the DevTools endpoint.'
if (( is_wsl )); then
  resolved_curl="$(readlink -f -- "$curl_bin" 2>/dev/null || printf '%s' "$curl_bin")"
  case "$curl_bin:$resolved_curl" in
    /mnt:*|/mnt/*:*|*:/mnt|*:/mnt/*)
      fail 'curl must be Linux-native inside WSL; executables resolved through /mnt are refused'
      ;;
  esac
fi

is_chrome_devtools_ready() {
  local response
  response="$("$curl_bin" --fail --silent --show-error --max-time 1 \
    "http://127.0.0.1:$PORT/json/version" 2>/dev/null)" || return 1
  [[ "$response" == *'"Browser"'* ]] &&
    [[ "$response" == *'Chrome/'* ]] &&
    [[ "$response" == *'"webSocketDebuggerUrl"'* ]]
}

if (( is_wsl )); then
  powershell_bin="$(type -P powershell.exe || true)"
  [[ -n "$powershell_bin" ]] || fail 'WSL interop cannot find powershell.exe.'

  # PORT is interpolated below only after the strict numeric/range validation above.
  # Passing one quoted argument line also preserves a profile path containing spaces.
  "$powershell_bin" -NoLogo -NoProfile -NonInteractive -Command '
    $ErrorActionPreference = "Stop"
    $candidateSpecs = @(
      @{ Root = $env:ProgramFiles; Suffix = "Google\Chrome\Application\chrome.exe" },
      @{ Root = ${env:ProgramFiles(x86)}; Suffix = "Google\Chrome\Application\chrome.exe" },
      @{ Root = $env:LOCALAPPDATA; Suffix = "Google\Chrome\Application\chrome.exe" }
    )
    $candidates = foreach ($candidate in $candidateSpecs) {
      if ($candidate.Root) { Join-Path -Path $candidate.Root -ChildPath $candidate.Suffix }
    }
    $chrome = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $chrome) { throw "Google Chrome was not found" }
    if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is unavailable" }

    $profile = Join-Path -Path $env:LOCALAPPDATA -ChildPath "RelayBridge\ChromeDevToolsProfile"
    New-Item -ItemType Directory -Force -Path $profile | Out-Null
    $quote = [char]34
    $profileArgument = $quote + "--user-data-dir=$profile" + $quote
    $argumentLine = @(
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port='"$PORT"'",
      $profileArgument,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank"
    ) -join " "
    Start-Process -FilePath $chrome -ArgumentList $argumentLine -ErrorAction Stop | Out-Null
  '
else
  [[ -n "${HOME:-}" ]] || fail 'HOME is not set.'
  chrome_bin="$(type -P google-chrome || type -P google-chrome-stable || true)"
  [[ -n "$chrome_bin" ]] || fail 'Google Chrome is not installed.'
  profile="${XDG_CACHE_HOME:-$HOME/.cache}/relaybridge/chrome-devtools-profile"
  mkdir -p -- "$profile"
  chmod 700 -- "$profile"
  "$chrome_bin" --remote-debugging-address=127.0.0.1 --remote-debugging-port="$PORT" \
    --user-data-dir="$profile" --no-first-run --no-default-browser-check \
    about:blank >/dev/null 2>&1 &
  disown || true
fi

for (( attempt = 1; attempt <= 60; attempt++ )); do
  if is_chrome_devtools_ready; then
    printf '[RelayBridge] dedicated Chrome DevTools profile is ready at http://127.0.0.1:%s\n' "$PORT"
    printf '%s\n' '[RelayBridge] security: this loopback port grants full control of that profile; keep it private and use no sensitive accounts.'
    exit 0
  fi
  sleep 0.25
done

if (( is_wsl )); then
  printf '%s\n' '[RelayBridge] Chrome launched, but WSL could not verify its loopback DevTools endpoint.' >&2
  printf '%s\n' 'Enable WSL mirrored networking, then rerun this script. Do not expose the debugging port publicly.' >&2
else
  printf '%s\n' '[RelayBridge] Chrome launched, but its loopback DevTools endpoint did not become ready.' >&2
fi
exit 1

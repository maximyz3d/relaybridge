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
BRIDGE_PORT="${RELAYBRIDGE_CHROME_WSL_BRIDGE_PORT:-49222}"
[[ "$BRIDGE_PORT" =~ ^[0-9]+$ ]] && (( BRIDGE_PORT >= 1 && BRIDGE_PORT <= 65535 )) || \
  fail 'RELAYBRIDGE_CHROME_WSL_BRIDGE_PORT must be 1-65535.'
[[ "$BRIDGE_PORT" != "$PORT" ]] || \
  fail 'RELAYBRIDGE_CHROME_WSL_BRIDGE_PORT must differ from RELAYBRIDGE_CHROME_PORT.'

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

is_chrome_devtools_ready_at() {
  local endpoint="$1"
  local response
  response="$("$curl_bin" --disable --noproxy '*' --fail --silent --show-error --max-time 1 \
    --header "Host: 127.0.0.1:$PORT" "$endpoint/json/version" 2>/dev/null)" || return 1
  [[ "$response" == *'"Browser"'* ]] &&
    [[ "$response" == *'Chrome/'* ]] &&
    [[ "$response" == *'"webSocketDebuggerUrl"'*"ws://127.0.0.1:$PORT/"* ]]
}

is_chrome_devtools_ready() {
  is_chrome_devtools_ready_at "http://127.0.0.1:$PORT"
}

is_private_ipv4() {
  local address="$1" first second third fourth
  IFS=. read -r first second third fourth <<< "$address"
  for octet in "$first" "$second" "$third" "$fourth"; do
    [[ "$octet" =~ ^[0-9]+$ ]] && (( octet >= 0 && octet <= 255 )) || return 1
  done
  (( first == 10 )) ||
    (( first == 172 && second >= 16 && second <= 31 )) ||
    (( first == 192 && second == 168 ))
}

start_wsl_nat_forward() {
  local gateway source_ip route_line route_get proxy_script windows_proxy_script proxy_endpoint
  local socat_bin resolved_socat runtime_base runtime_dir runtime_owner
  local pid_file log_file old_pid old_command proxy_pid
  local windows_proxy_pid='' proxy_started=0 forward_started=0 inherited_wslenv proxy_wslenv field
  local systemctl_bin='' systemd_run_bin='' unit_name='' use_systemd=0
  local -a default_routes route_fields route_get_fields

  mapfile -t default_routes < <(ip -4 route show default 2>/dev/null)
  if (( ${#default_routes[@]} != 1 )); then
    printf '%s\n' '[RelayBridge] refusing ambiguous or missing WSL default route for Chrome proxy.' >&2
    return 1
  fi
  route_line="${default_routes[0]}"
  read -r -a route_fields <<< "$route_line"
  gateway=''
  for (( field = 0; field + 1 < ${#route_fields[@]}; field++ )); do
    if [[ "${route_fields[field]}" == via ]]; then
      gateway="${route_fields[field + 1]}"
      break
    fi
  done
  is_private_ipv4 "$gateway" || {
    printf '[RelayBridge] refusing unsafe WSL gateway for Chrome proxy: %s\n' "${gateway:-missing}" >&2
    return 1
  }

  route_get="$(ip -4 route get "$gateway" 2>/dev/null)" || route_get=''
  read -r -a route_get_fields <<< "$route_get"
  source_ip=''
  for (( field = 0; field + 1 < ${#route_get_fields[@]}; field++ )); do
    if [[ "${route_get_fields[field]}" == src ]]; then
      source_ip="${route_get_fields[field + 1]}"
      break
    fi
  done
  if ! is_private_ipv4 "$source_ip" || [[ "$source_ip" == "$gateway" ]]; then
    printf '[RelayBridge] refusing unsafe WSL source address for Chrome proxy: %s\n' "${source_ip:-missing}" >&2
    return 1
  fi

  socat_bin="$(type -P socat || true)"
  [[ -n "$socat_bin" ]] || {
    printf '%s\n' '[RelayBridge] socat is required for WSL NAT Chrome forwarding.' >&2
    return 1
  }
  resolved_socat="$(readlink -f -- "$socat_bin" 2>/dev/null || printf '%s' "$socat_bin")"
  case "$socat_bin:$resolved_socat" in
    /mnt:*|/mnt/*:*|*:/mnt|*:/mnt/*)
      printf '%s\n' '[RelayBridge] socat must be Linux-native inside WSL.' >&2
      return 1
      ;;
  esac

  proxy_script="$script_dir/tools/chrome-wsl-tcp-proxy.cjs"
  [[ -f "$proxy_script" ]] || {
    printf '[RelayBridge] WSL Chrome proxy helper is missing: %s\n' "$proxy_script" >&2
    return 1
  }
  windows_proxy_script="$(wslpath -w "$proxy_script" 2>/dev/null)" || return 1
  proxy_endpoint="http://$gateway:$BRIDGE_PORT"
  inherited_wslenv="${WSLENV:-}"
  proxy_wslenv='RB_CHROME_PROXY_SCRIPT_WIN:RB_CHROME_PROXY_HOST:RB_CHROME_PROXY_BRIDGE_PORT:RB_CHROME_PROXY_TARGET_PORT:RB_CHROME_PROXY_SOURCE:RB_CHROME_PROXY_PID'
  [[ -z "$inherited_wslenv" ]] || proxy_wslenv="$inherited_wslenv:$proxy_wslenv"

  cleanup_new_windows_proxy() {
    (( proxy_started == 1 )) || return 0
    RB_CHROME_PROXY_SCRIPT_WIN="$windows_proxy_script" \
      RB_CHROME_PROXY_PID="$windows_proxy_pid" \
      WSLENV="$proxy_wslenv" \
      "$powershell_bin" -NoLogo -NoProfile -NonInteractive -Command '
        $pidValue = 0
        if (-not [int]::TryParse($env:RB_CHROME_PROXY_PID, [ref]$pidValue)) { exit 0 }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
        if ($process -and $process.Name -eq "node.exe" -and $process.CommandLine -and
            $process.CommandLine.ToLowerInvariant().Contains($env:RB_CHROME_PROXY_SCRIPT_WIN.ToLowerInvariant())) {
          Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
        }
      ' >/dev/null 2>&1 || true
    proxy_started=0
  }

  cleanup_failed_nat_forward() {
    if (( forward_started == 1 )); then
      if (( use_systemd == 1 )) && [[ -n "$systemctl_bin" && -n "$unit_name" ]]; then
        "$systemctl_bin" --user stop "$unit_name.service" >/dev/null 2>&1 || true
      elif [[ "${proxy_pid:-}" =~ ^[0-9]+$ ]]; then
        kill "$proxy_pid" 2>/dev/null || true
      fi
      forward_started=0
    fi
    cleanup_new_windows_proxy
    trap - HUP INT TERM
  }
  trap 'cleanup_failed_nat_forward; exit 130' HUP INT TERM

  windows_proxy_pid="$(
    RB_CHROME_PROXY_SCRIPT_WIN="$windows_proxy_script" \
      RB_CHROME_PROXY_HOST="$gateway" \
      RB_CHROME_PROXY_BRIDGE_PORT="$BRIDGE_PORT" \
      RB_CHROME_PROXY_TARGET_PORT="$PORT" \
      RB_CHROME_PROXY_SOURCE="$source_ip" \
      WSLENV="$proxy_wslenv" \
      "$powershell_bin" -NoLogo -NoProfile -NonInteractive -Command '
          $ErrorActionPreference = "Stop"
          $script = $env:RB_CHROME_PROXY_SCRIPT_WIN
          $listenAddress = $env:RB_CHROME_PROXY_HOST
          $sourceAddress = $env:RB_CHROME_PROXY_SOURCE
          $bridgePort = [int]$env:RB_CHROME_PROXY_BRIDGE_PORT
          $targetPort = [int]$env:RB_CHROME_PROXY_TARGET_PORT
          if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "Chrome proxy helper is unavailable" }

          $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -IPAddress $listenAddress -ErrorAction Stop |
            Where-Object { $_.AddressState -eq "Preferred" })
          if ($addresses.Count -ne 1) { throw "WSL gateway does not resolve to one preferred Windows adapter address" }
          $address = $addresses[0]
          $adapter = Get-NetAdapter -InterfaceIndex $address.InterfaceIndex -ErrorAction Stop
          if ($address.InterfaceAlias -notmatch "(?i)WSL" -or
              $adapter.InterfaceDescription -notmatch "(?i)Hyper-V.*Ethernet") {
            throw "refusing a Chrome proxy outside the Hyper-V WSL adapter"
          }

          function Test-SameIPv4Subnet([string]$left, [string]$right, [int]$prefixLength) {
            $leftBytes = [Net.IPAddress]::Parse($left).GetAddressBytes()
            $rightBytes = [Net.IPAddress]::Parse($right).GetAddressBytes()
            $wholeBytes = [Math]::Floor($prefixLength / 8)
            for ($index = 0; $index -lt $wholeBytes; $index++) {
              if ($leftBytes[$index] -ne $rightBytes[$index]) { return $false }
            }
            $remainingBits = $prefixLength % 8
            if ($remainingBits -gt 0) {
              $byteMask = 0xff -band (0xff -shl (8 - $remainingBits))
              if (($leftBytes[$wholeBytes] -band $byteMask) -ne
                  ($rightBytes[$wholeBytes] -band $byteMask)) { return $false }
            }
            return $true
          }
          if (-not (Test-SameIPv4Subnet $listenAddress $sourceAddress ([int]$address.PrefixLength))) {
            throw "WSL source address is outside the private adapter subnet"
          }

          $chromeVersion = Invoke-RestMethod -Uri "http://127.0.0.1:$targetPort/json/version" -TimeoutSec 2
          $webSocketUri = [Uri]$chromeVersion.webSocketDebuggerUrl
          if (-not ([string]$chromeVersion.Browser).StartsWith("Chrome/", [StringComparison]::Ordinal) -or
              $webSocketUri.Scheme -ne "ws" -or $webSocketUri.Host -ne "127.0.0.1" -or
              $webSocketUri.Port -ne $targetPort) {
            throw "Windows Chrome DevTools endpoint failed loopback identity validation"
          }

          $node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
          if (-not $node -or $node.StartsWith("\\wsl", [StringComparison]::OrdinalIgnoreCase)) {
            throw "Windows node.exe is required for the WSL Chrome proxy"
          }
          $needle = $script.ToLowerInvariant()
          $existing = Get-CimInstance Win32_Process | Where-Object {
            $_.Name -eq "node.exe" -and $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle)
          }
          foreach ($process in $existing) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }
          $quote = [char]34
          $argumentLine = $quote + $script + $quote + " " + $listenAddress + " " + $bridgePort +
            " " + $targetPort + " " + $sourceAddress
          $child = $null
          try {
            $child = Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList $argumentLine -PassThru -ErrorAction Stop
            $deadline = (Get-Date).AddSeconds(5)
            $listener = $null
            while ((Get-Date) -lt $deadline) {
              $child.Refresh()
              if ($child.HasExited) { throw "Windows Chrome proxy exited before binding its private listener" }
              $listener = Get-NetTCPConnection -State Listen -LocalAddress $listenAddress -LocalPort $bridgePort `
                -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $child.Id } | Select-Object -First 1
              if ($listener) { break }
              Start-Sleep -Milliseconds 100
            }
            if (-not $listener) { throw "Windows Chrome proxy did not own the requested private listener" }
            $actual = Get-CimInstance Win32_Process -Filter "ProcessId = $($child.Id)" -ErrorAction Stop
            foreach ($expected in @($script, $listenAddress, [string]$bridgePort, [string]$targetPort, $sourceAddress)) {
              if ($actual.CommandLine.IndexOf($expected, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
                throw "Windows Chrome proxy command identity did not verify"
              }
            }
            $child.Id
          } catch {
            if ($child -and -not $child.HasExited) {
              Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue
            }
            throw
          }
        '
  )" || {
    trap - HUP INT TERM
    return 1
  }
  windows_proxy_pid="${windows_proxy_pid//$'\r'/}"
  [[ "$windows_proxy_pid" =~ ^[0-9]+$ ]] || {
    printf '%s\n' '[RelayBridge] Windows-side Chrome proxy returned an invalid process id.' >&2
    trap - HUP INT TERM
    return 1
  }
  proxy_started=1

  for (( attempt = 1; attempt <= 20; attempt++ )); do
    is_chrome_devtools_ready_at "$proxy_endpoint" && break
    sleep 0.25
  done
  if ! is_chrome_devtools_ready_at "$proxy_endpoint"; then
    printf '%s\n' '[RelayBridge] Windows-side private WSL Chrome proxy did not become ready.' >&2
    cleanup_failed_nat_forward
    return 1
  fi

  runtime_base="${XDG_RUNTIME_DIR:-/tmp}"
  runtime_dir="$runtime_base/relaybridge-$UID"
  if [[ -L "$runtime_dir" ]]; then
    printf '[RelayBridge] refusing symlinked runtime directory: %s\n' "$runtime_dir" >&2
    cleanup_failed_nat_forward
    return 1
  fi
  mkdir -p -m 700 -- "$runtime_dir" || {
    cleanup_failed_nat_forward
    return 1
  }
  runtime_owner="$(stat -c '%u' -- "$runtime_dir" 2>/dev/null || true)"
  if [[ "$runtime_owner" != "$UID" ]]; then
    printf '[RelayBridge] refusing runtime directory not owned by uid %s.\n' "$UID" >&2
    cleanup_failed_nat_forward
    return 1
  fi
  chmod 700 -- "$runtime_dir" || {
    cleanup_failed_nat_forward
    return 1
  }
  pid_file="$runtime_dir/chrome-wsl-forward-$PORT.pid"
  log_file="$runtime_dir/chrome-wsl-forward-$PORT.log"
  unit_name="relaybridge-chrome-wsl-forward-$PORT"

  if [[ -f "$pid_file" ]]; then
    old_pid="$(<"$pid_file")"
    if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
      old_command="$(tr '\0' ' ' < "/proc/$old_pid/cmdline" 2>/dev/null || true)"
      if [[ "$old_command" == *socat* && "$old_command" == *"TCP4-LISTEN:$PORT,bind=127.0.0.1"* ]]; then
        kill "$old_pid" 2>/dev/null || true
        for (( attempt = 1; attempt <= 20; attempt++ )); do
          kill -0 "$old_pid" 2>/dev/null || break
          sleep 0.05
        done
      else
        printf '%s\n' '[RelayBridge] refusing to replace a process not owned by the Chrome forwarder.' >&2
        cleanup_failed_nat_forward
        return 1
      fi
    fi
    rm -f -- "$pid_file" || {
      cleanup_failed_nat_forward
      return 1
    }
  fi

  systemctl_bin="$(type -P systemctl || true)"
  systemd_run_bin="$(type -P systemd-run || true)"
  if [[ -n "$systemctl_bin" && -n "$systemd_run_bin" ]] &&
      "$systemctl_bin" --user show-environment >/dev/null 2>&1; then
    use_systemd=1
    "$systemctl_bin" --user stop "$unit_name.service" >/dev/null 2>&1 || true
    "$systemctl_bin" --user reset-failed "$unit_name.service" >/dev/null 2>&1 || true
    : > "$log_file" || {
      cleanup_failed_nat_forward
      return 1
    }
    "$systemd_run_bin" --user --quiet --unit="$unit_name" --collect \
      --property="StandardOutput=append:$log_file" \
      --property="StandardError=append:$log_file" \
      "$socat_bin" "TCP4-LISTEN:$PORT,bind=127.0.0.1,reuseaddr,fork" \
      "TCP4:$gateway:$BRIDGE_PORT" || {
        cleanup_failed_nat_forward
        return 1
      }
    forward_started=1
    proxy_pid="$($systemctl_bin --user show --property=MainPID --value "$unit_name.service")" || {
      cleanup_failed_nat_forward
      return 1
    }
    [[ "$proxy_pid" =~ ^[0-9]+$ ]] || {
      cleanup_failed_nat_forward
      return 1
    }
  else
    nohup setsid "$socat_bin" "TCP4-LISTEN:$PORT,bind=127.0.0.1,reuseaddr,fork" \
      "TCP4:$gateway:$BRIDGE_PORT" >"$log_file" 2>&1 < /dev/null &
    proxy_pid=$!
    forward_started=1
    printf '%s\n' "$proxy_pid" > "$pid_file.tmp" || {
      cleanup_failed_nat_forward
      return 1
    }
    mv -f -- "$pid_file.tmp" "$pid_file" || {
      cleanup_failed_nat_forward
      return 1
    }
    disown || true
  fi

  for (( attempt = 1; attempt <= 20; attempt++ )); do
    if is_chrome_devtools_ready; then
      printf '[RelayBridge] WSL NAT forward is active through private adapter %s; source restricted to %s.\n' \
        "$gateway" "$source_ip"
      proxy_started=0
      forward_started=0
      trap - HUP INT TERM
      return 0
    fi
    if (( use_systemd )); then
      "$systemctl_bin" --user is-active --quiet "$unit_name.service" || break
    else
      kill -0 "$proxy_pid" 2>/dev/null || break
    fi
    sleep 0.25
  done
  cleanup_failed_nat_forward
  rm -f -- "$pid_file"
  printf '[RelayBridge] WSL loopback Chrome forward failed; see %s\n' "$log_file" >&2
  return 1
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

for (( attempt = 1; attempt <= 20; attempt++ )); do
  if is_chrome_devtools_ready; then
    printf '[RelayBridge] dedicated Chrome DevTools profile is ready at http://127.0.0.1:%s\n' "$PORT"
    printf '%s\n' '[RelayBridge] security: this loopback port grants full control of that profile; keep it private and use no sensitive accounts.'
    exit 0
  fi
  sleep 0.25
done

if (( is_wsl )); then
  if start_wsl_nat_forward && is_chrome_devtools_ready; then
    printf '[RelayBridge] dedicated Chrome DevTools profile is ready at http://127.0.0.1:%s\n' "$PORT"
    printf '%s\n' '[RelayBridge] security: this loopback port grants full control of that profile; keep it private and use no sensitive accounts.'
    exit 0
  fi
  printf '%s\n' '[RelayBridge] Chrome launched, but WSL could not establish a private DevTools path.' >&2
  printf '%s\n' 'Enable WSL mirrored networking or install Linux-native socat, then rerun. Do not expose the debugging port publicly.' >&2
else
  printf '%s\n' '[RelayBridge] Chrome launched, but its loopback DevTools endpoint did not become ready.' >&2
fi
exit 1

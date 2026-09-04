#!/usr/bin/env bash
# RelayBridge start script for WSL / Linux / macOS — the start.ps1 equivalent.
# Usage: ./start.sh            start in the background, health-checked
#        ./start.sh --fg       run in the foreground (systemd, debugging)
#        ./start.sh --stop     stop a running bridge
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${RELAYBRIDGE_PORT:-${PORT:-8787}}"
# server.js reads PORT, not RELAYBRIDGE_PORT. Without exporting it, passing
# only RELAYBRIDGE_PORT started the server on 8787 while this script
# health-checked the other port and then declared a healthy bridge dead.
export PORT
LOG="$ROOT/bridge.start.out.log"
ERR="$ROOT/bridge.start.err.log"
# Port-scoped. The old shared "$ROOT/.bridge.pid" was written by whichever
# bridge started last regardless of its port, so running two bridges (the
# documented Windows-8787 / WSL-8788 topology) left one file naming the other
# port's process.
PIDFILE="$ROOT/.bridge.$PORT.pid"
LEGACY_PIDFILE="$ROOT/.bridge.pid"

# Does $1 actually own $PORT? A pidfile is a hint, never proof: it can be stale,
# left over from the pre-port-scoped layout, or name a recycled pid.
pid_owns_port() {
  local p="${1:-}"
  local source_file="${2:-}"
  [[ -n "$p" ]] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | grep ":$PORT " | grep -q "pid=$p,"
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | grep -qx "$p"
    return
  fi
  # With no kernel inspector, only the port-scoped pidfile is a sufficiently
  # narrow hint. The shared legacy file may name a healthy bridge on any port.
  [[ "$source_file" == "$PIDFILE" ]]
}

listening_pid() {
  # The PORT is the identity, so ask the kernel first and treat the pidfile as
  # the last resort. The old order asked the pidfile first, which is how
  # `./start.sh --stop` (PORT defaulting to 8787) killed a bridge on 8788 and
  # then reported success. NOTE: no gawk-isms — Ubuntu's default awk is mawk,
  # and the 3-arg match() silently returns nothing there.
  local p
  if command -v ss >/dev/null 2>&1; then
    p="$(ss -ltnp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
    if [[ -n "$p" ]]; then echo "$p"; return; fi
  fi
  if command -v lsof >/dev/null 2>&1; then
    p="$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1)"
    if [[ -n "$p" ]]; then echo "$p"; return; fi
  fi
  local f
  for f in "$PIDFILE" "$LEGACY_PIDFILE"; do
    [[ -f "$f" ]] || continue
    p="$(cat "$f" 2>/dev/null || true)"
    if pid_owns_port "$p" "$f"; then echo "$p"; return; fi
  done
}

if [[ "${1:-}" == "--stop" ]]; then
  pid="$(listening_pid || true)"
  if [[ -n "${pid:-}" ]]; then
    kill "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    # Only clear the shared legacy file if it named THIS bridge; another port's
    # bridge may still be relying on it.
    if [[ -f "$LEGACY_PIDFILE" && "$(cat "$LEGACY_PIDFILE" 2>/dev/null || true)" == "$pid" ]]; then
      rm -f "$LEGACY_PIDFILE"
    fi
    echo "[RelayBridge] stopped pid $pid on :$PORT"
  else
    echo "[RelayBridge] nothing listening on :$PORT"
  fi
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "[RelayBridge] node not found — run setup-wsl.sh first" >&2; exit 1; }
node_bin="$(command -v node)"
build_info_tool="$ROOT/tools/prepare-build-info.cjs"
[[ -f "$build_info_tool" ]] || { echo "[RelayBridge] build identity tool not found: $build_info_tool" >&2; exit 1; }

# Git/npm/model-CLI workloads are metadata-heavy. On WSL, placing any runtime
# component under /mnt crosses DrvFs/9p and is both slower and less reliable for
# POSIX permissions. Refuse that topology by default; Chrome remains the one
# intentional Windows-side GUI and is reached through a narrow launcher/CDP.
if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; then
  slow_paths=()
  [[ "$ROOT" == /mnt || "$ROOT" == /mnt/* ]] && slow_paths+=(checkout)
  [[ "$node_bin" == /mnt || "$node_bin" == /mnt/* ]] && slow_paths+=(node)
  for spec in \
    "data:${RELAYBRIDGE_DATA_DIR:-${PS_BRIDGE_DATA_DIR:-}}" \
    "token:${RELAYBRIDGE_TOKEN_FILE:-${PS_BRIDGE_TOKEN_FILE:-}}" \
    "config:${RELAYBRIDGE_CONFIG_FILE:-${PS_BRIDGE_CONFIG_FILE:-}}"; do
    label="${spec%%:*}"
    candidate="${spec#*:}"
    [[ "$candidate" == /mnt || "$candidate" == /mnt/* ]] && slow_paths+=("$label")
  done
  if (( ${#slow_paths[@]} )) && [[ "${RELAYBRIDGE_ALLOW_SLOW_WSL_FS:-}" != 1 ]]; then
    echo "[RelayBridge] refusing slow WSL /mnt execution for: ${slow_paths[*]}" >&2
    echo "Move RelayBridge, data, token, config, and Linux Node under /home, then retry." >&2
    exit 1
  fi
fi

# Pin this launch to the exact Git working-tree bytes before replacing a live
# listener. Ignored runtime state (token, data, logs, pidfiles, dependencies)
# is outside the digest, so normal bridge activity cannot churn the identity.
expected_build_id=$("$node_bin" "$build_info_tool" "$ROOT") || exit 1
[[ -n "$expected_build_id" ]] || { echo '[RelayBridge] build identity tool returned an empty build id' >&2; exit 1; }
export RELAYBRIDGE_EXPECTED_BUILD_ID="$expected_build_id"
echo "[RelayBridge] prepared exact build $expected_build_id"

# One bridge per port: replace, never stack.
existing="$(listening_pid || true)"
if [[ -n "${existing:-}" ]]; then
  echo "[RelayBridge] replacing bridge pid $existing on :$PORT"
  kill "$existing" 2>/dev/null || true
  for _ in $(seq 1 20); do [[ -z "$(listening_pid || true)" ]] && break; sleep 0.3; done
  remaining="$(listening_pid || true)"
  if [[ -n "${remaining:-}" ]]; then
    echo "[RelayBridge] bridge pid $remaining still owns :$PORT; refusing to overlap it" >&2
    exit 1
  fi
fi

if [[ "${1:-}" == "--fg" ]]; then
  exec "$node_bin" "$ROOT/server.js"
fi

# Background: the shell inside the new session writes its own PID before exec,
# so the handoff remains exact even when util-linux setsid decides to fork. The
# exec then makes that same session-leader PID the Node server process.
command -v setsid >/dev/null 2>&1 || { echo '[RelayBridge] setsid is required for a detached start' >&2; exit 1; }
handoff_tmp_base="${TMPDIR:-/tmp}"
if { [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; } &&
   [[ "$handoff_tmp_base" == /mnt || "$handoff_tmp_base" == /mnt/* ]]; then
  handoff_tmp_base=/tmp
fi
handoff_file="$(mktemp "$handoff_tmp_base/relaybridge-start.$PORT.XXXXXX")"
handoff_nonce="$("$node_bin" -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
[[ "$handoff_nonce" =~ ^[a-f0-9]{32}$ ]] || { echo '[RelayBridge] could not create a detached-start handoff nonce' >&2; rm -f "$handoff_file"; exit 1; }
started_pid=
started_group_owned=0
pidfile_ready=0
launcher_pid=
launch_committed=0

capture_started_pid() {
  if [[ -n "$started_pid" ]]; then
    [[ "$started_group_owned" -eq 1 && "$pidfile_ready" -eq 1 ]] && return 0
    return 2
  fi
  if [[ -e "$handoff_file" || -L "$handoff_file" ]]; then
    [[ -f "$handoff_file" && ! -L "$handoff_file" ]] || return 2
  fi
  [[ -s "$handoff_file" ]] || return 1
  local record candidate_nonce candidate ppid pgid sid
  record="$(cat "$handoff_file" 2>/dev/null || true)"
  candidate_nonce="${record%%:*}"
  candidate="${record#*:}"
  [[ "$candidate_nonce" == "$handoff_nonce" && "$record" == "$candidate_nonce:$candidate" ]] || return 2
  [[ "$candidate" =~ ^[1-9][0-9]*$ ]] || return 1
  # Treat handoff bytes as untrusted until the candidate is both live and the
  # leader of the exact process group/session created for this launch, and is
  # still the direct child of our retained setsid --fork --wait process.
  # Keeping it local until every proof succeeds ensures cleanup can never
  # signal an injected PID, even when that PID leads some unrelated session.
  kill -0 "$candidate" 2>/dev/null || return 2
  ppid="$(ps -o ppid= -p "$candidate" 2>/dev/null | tr -d '[:space:]')"
  pgid="$(ps -o pgid= -p "$candidate" 2>/dev/null | tr -d '[:space:]')"
  sid="$(ps -o sid= -p "$candidate" 2>/dev/null | tr -d '[:space:]')"
  if [[ -z "$launcher_pid" || "$ppid" != "$launcher_pid" ||
        "$pgid" != "$candidate" || "$sid" != "$candidate" ]]; then
    return 2
  fi
  started_pid="$candidate"
  started_group_owned=1
  printf '%s\n' "$started_pid" > "$PIDFILE" || return 2
  pidfile_ready=1
}

cleanup_started_process() {
  local _ capture_status
  # A signal can arrive just before the normal handoff poll sees the file.
  # Keep the retained setsid parent alive briefly so its real child can publish
  # a relationship-verifiable handoff. Until that proof succeeds, the direct
  # launcher is the only process this script is authorized to signal.
  if [[ -z "$started_pid" && -n "$launcher_pid" ]]; then
    for _ in $(seq 1 100); do
      if capture_started_pid >/dev/null 2>&1; then break; else capture_status=$?; fi
      [[ "$capture_status" -eq 2 ]] && break
      kill -0 "$launcher_pid" 2>/dev/null || break
      sleep 0.05
    done
  fi
  if [[ "$started_group_owned" -eq 1 && -n "$started_pid" ]]; then
    kill -TERM -- "-$started_pid" 2>/dev/null || true
  elif [[ -n "$started_pid" ]]; then
    kill -TERM "$started_pid" 2>/dev/null || true
  fi
  if [[ -n "$launcher_pid" && "$launcher_pid" != "$started_pid" ]]; then
    kill -TERM "$launcher_pid" 2>/dev/null || true
  fi
  for _ in $(seq 1 20); do
    if [[ "$started_group_owned" -eq 1 && -n "$started_pid" ]]; then
      kill -0 -- "-$started_pid" 2>/dev/null || break
    elif [[ -n "$started_pid" ]]; then
      kill -0 "$started_pid" 2>/dev/null || break
    else
      break
    fi
    sleep 0.1
  done
  if [[ "$started_group_owned" -eq 1 && -n "$started_pid" ]]; then
    kill -KILL -- "-$started_pid" 2>/dev/null || true
  elif [[ -n "$started_pid" ]]; then
    kill -KILL "$started_pid" 2>/dev/null || true
  fi
  if [[ -n "$started_pid" && -f "$PIDFILE" && "$(cat "$PIDFILE" 2>/dev/null || true)" == "$started_pid" ]]; then
    rm -f "$PIDFILE"
  fi
  rm -f "$handoff_file" 2>/dev/null || true
}

on_launch_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [[ "$launch_committed" -ne 1 ]]; then cleanup_started_process; fi
  exit "$status"
}
trap on_launch_exit EXIT
trap 'launch_committed=0; exit 129' HUP
trap 'launch_committed=0; exit 130' INT
trap 'launch_committed=0; exit 143' TERM

nohup setsid --fork --wait sh -c '
  handoff=$1
  nonce=$2
  node_bin=$3
  server_path=$4
  umask 077
  printf "%s:%s\n" "$nonce" "$$" > "$handoff" || exit 70
  exec "$node_bin" "$server_path"
' relaybridge-session "$handoff_file" "$handoff_nonce" "$node_bin" "$ROOT/server.js" >>"$LOG" 2>>"$ERR" < /dev/null &
launcher_pid=$!

handoff_status=1
for _ in $(seq 1 100); do
  if capture_started_pid; then handoff_status=0; break; else handoff_status=$?; fi
  [[ "$handoff_status" -eq 2 ]] && break
  sleep 0.05
done
if [[ "$handoff_status" -ne 0 || -z "$started_pid" || "$started_group_owned" -ne 1 || "$pidfile_ready" -ne 1 ]]; then
  echo '[RelayBridge] detached server did not provide a valid session-leader PID handoff' >&2
  exit 1
fi

failure_detail='health timeout'
for _ in $(seq 1 30); do
  if health="$(curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"; then
    reported_pid="$(printf '%s' "$health" | "$node_bin" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const p=JSON.parse(d).pid;if(Number.isSafeInteger(p)&&p>0)process.stdout.write(String(p))}catch{}})')"
    if printf '%s' "$health" | "$node_bin" -e '
      let d = "";
      process.stdin.on("data", (chunk) => { d += chunk; }).on("end", () => {
        try {
          const value = JSON.parse(d);
          const expectedPid = Number(process.argv[2]);
          process.exit(
            Number.isSafeInteger(value.pid) && value.pid === expectedPid &&
            value.capabilityAuth === true && value.buildIdentityReady === true &&
            value.buildId === process.argv[1] ? 0 : 1
          );
        } catch { process.exit(1); }
      });
    ' "$expected_build_id" "$started_pid"; then
      rm -f "$handoff_file" 2>/dev/null || true
      ver="$(printf '%s' "$health" | "$node_bin" -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.buildId+" (pid "+j.pid+")")}catch{console.log("?")}})')"
      echo "[RelayBridge] healthy at http://127.0.0.1:$PORT — $ver"
      launch_committed=1
      exit 0
    fi
    failure_detail="health identity/capability mismatch (reported pid ${reported_pid:-unknown})"
    # Identity readiness and capability authentication are immutable for this
    # process. Once our exact candidate responds incorrectly, fail immediately.
    [[ "$reported_pid" == "$started_pid" ]] && break
  fi
  kill -0 "$started_pid" 2>/dev/null || { failure_detail='detached server exited before ready health'; break; }
  sleep 0.5
done

echo "[RelayBridge] failed to become healthy on :$PORT — $failure_detail; last errors:" >&2
tail -5 "$ERR" >&2 || true
exit 1

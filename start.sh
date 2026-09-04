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

# Git/npm/model-CLI workloads are metadata-heavy. On WSL, placing any runtime
# component under /mnt crosses DrvFs/9p and is both slower and less reliable for
# POSIX permissions. Refuse that topology by default; Chrome remains the one
# intentional Windows-side GUI and is reached through a narrow launcher/CDP.
if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/version 2>/dev/null; then
  slow_paths=()
  node_bin="$(command -v node)"
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

# One bridge per port: replace, never stack.
existing="$(listening_pid || true)"
if [[ -n "${existing:-}" ]]; then
  echo "[RelayBridge] replacing bridge pid $existing on :$PORT"
  kill "$existing" 2>/dev/null || true
  for _ in $(seq 1 20); do [[ -z "$(listening_pid || true)" ]] && break; sleep 0.3; done
fi

if [[ "${1:-}" == "--fg" ]]; then
  exec node "$ROOT/server.js"
fi

# Background: detached with its own session so closing the terminal — or the
# thing that restarted us — does not take the bridge down with it. This is the
# trap the Windows side fell into twice: a restart initiated through the
# bridge's own exec channel died with its parent.
nohup setsid node "$ROOT/server.js" >>"$LOG" 2>>"$ERR" < /dev/null &
# $! is the pid of `nohup`/`setsid`, and setsid forks when it is not already a
# process group leader — so this can name a wrapper that exits immediately. Keep
# it only as a stopgap for the seconds before the health check, then overwrite
# it with the pid the bridge reports for itself.
echo $! > "$PIDFILE"

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    health="$(curl -fsS "http://127.0.0.1:$PORT/api/health")"
    realpid="$(printf '%s' "$health" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).pid||""))}catch{}})')"
    [[ -n "$realpid" ]] && echo "$realpid" > "$PIDFILE"
    ver="$(printf '%s' "$health" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.version+" (pid "+j.pid+")")}catch{console.log("?")}})')"
    echo "[RelayBridge] healthy at http://127.0.0.1:$PORT — $ver"
    exit 0
  fi
  sleep 0.5
done

echo "[RelayBridge] failed to become healthy on :$PORT — last errors:" >&2
tail -5 "$ERR" >&2 || true
exit 1

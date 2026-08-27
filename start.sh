#!/usr/bin/env bash
# RelayBridge start script for WSL / Linux / macOS — the start.ps1 equivalent.
# Usage: ./start.sh            start in the background, health-checked
#        ./start.sh --fg       run in the foreground (systemd, debugging)
#        ./start.sh --stop     stop a running bridge
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${RELAYBRIDGE_PORT:-8787}"
LOG="$ROOT/bridge.start.out.log"
ERR="$ROOT/bridge.start.err.log"
PIDFILE="$ROOT/.bridge.pid"

listening_pid() {
  # Three sources, most reliable first. NOTE: no gawk-isms — Ubuntu's default
  # awk is mawk, and the 3-arg match() silently returns nothing there, which
  # made --stop report "nothing listening" while the bridge was demonstrably up.
  # 1. Our own pidfile, verified against a live process
  if [[ -f "$PIDFILE" ]]; then
    local p; p="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then echo "$p"; return; fi
  fi
  # 2. ss (Linux) — parse pid= with sed, portable across awks
  if command -v ss >/dev/null 2>&1; then
    local p; p="$(ss -ltnp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)"
    if [[ -n "$p" ]]; then echo "$p"; return; fi
  fi
  # 3. lsof (macOS, and Linux fallback)
  lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null | head -1
}

if [[ "${1:-}" == "--stop" ]]; then
  pid="$(listening_pid || true)"
  if [[ -n "${pid:-}" ]]; then
    kill "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
    echo "[RelayBridge] stopped pid $pid"
  else
    echo "[RelayBridge] nothing listening on :$PORT"
  fi
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "[RelayBridge] node not found — run setup-wsl.sh first" >&2; exit 1; }

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
echo $! > "$PIDFILE"

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    ver="$(curl -fsS "http://127.0.0.1:$PORT/api/health" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(j.version+" (pid "+j.pid+")")}catch{console.log("?")}})')"
    echo "[RelayBridge] healthy at http://127.0.0.1:$PORT — $ver"
    exit 0
  fi
  sleep 0.5
done

echo "[RelayBridge] failed to become healthy on :$PORT — last errors:" >&2
tail -5 "$ERR" >&2 || true
exit 1

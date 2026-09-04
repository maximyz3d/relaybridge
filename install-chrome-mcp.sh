#!/bin/sh

# Register Google's Chrome DevTools MCP for both native-WSL AI clients. The MCP
# process stays in WSL and connects over loopback to a dedicated Chrome profile.
set -eu
umask 077

name=chrome-devtools
browser_url=http://127.0.0.1:9222
package_version=1.8.0
full_tools=0
full_permissions=0
skip_codex=0
skip_claude=0

usage() {
  printf '%s\n' \
    'Usage: ./install-chrome-mcp.sh [--browser-url URL] [--full-tools] [--full-permissions] [--skip-codex] [--skip-claude]' \
    '' \
    'Default: pinned chrome-devtools-mcp 1.8.0 in token-efficient slim mode.' \
    'The URL must be loopback HTTP. Start the dedicated browser with ./start-chrome-debug.sh.'
}

fail() {
  printf '[RelayBridge] %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --browser-url)
      [ "$#" -ge 2 ] || fail '--browser-url requires a value'
      browser_url=$2
      shift 2
      ;;
    --full-tools) full_tools=1; shift ;;
    --full-permissions) full_permissions=1; shift ;;
    --skip-codex) skip_codex=1; shift ;;
    --skip-claude) skip_claude=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

case "$browser_url" in
  http://127.0.0.1:*) ;;
  *) fail 'Chrome DevTools URL must use http://127.0.0.1:PORT' ;;
esac
port=${browser_url#http://127.0.0.1:}
case "$port" in ''|*[!0-9]*) fail 'invalid Chrome DevTools port' ;; esac
[ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null || fail 'Chrome DevTools port must be 1-65535'

[ "$skip_codex" -eq 0 ] || [ "$skip_claude" -eq 0 ] || fail 'nothing to register: both clients were skipped'
[ -n "${HOME:-}" ] || fail 'HOME is not set'
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
is_wsl=0
if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then is_wsl=1; fi

native_command() {
  command_name=$1
  command_label=$2
  command_path=$(command -v "$command_name" 2>/dev/null || true)
  [ -n "$command_path" ] || fail "$command_label is not installed or is not on PATH"
  if [ "$is_wsl" -eq 1 ]; then
    resolved_path=$(readlink -f "$command_path" 2>/dev/null || printf '%s' "$command_path")
    case "$command_path:$resolved_path" in
      /mnt:*|/mnt/*:*|*:/mnt|*:/mnt/*)
        fail "$command_label must be Linux-native inside WSL; executables resolved through /mnt are refused"
        ;;
    esac
  fi
  printf '%s\n' "$command_path"
}

if [ "$is_wsl" -eq 1 ]; then
  case "$script_dir" in
    /mnt|/mnt/*) fail 'move RelayBridge under the WSL Linux filesystem before registering Chrome MCP' ;;
  esac
fi

node_path=$(native_command node 'Node.js')
npx_path=$(native_command npx 'npx')
"$node_path" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  const supported = (major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major >= 23;
  if (!supported) process.exit(1);
' || fail 'chrome-devtools-mcp 1.8.0 requires Node ^20.19.0, ^22.12.0, or >=23'
if [ "$skip_codex" -eq 0 ]; then codex_path=$(native_command codex 'Codex CLI'); fi
if [ "$skip_claude" -eq 0 ]; then claude_path=$(native_command claude 'Claude CLI'); fi

package="chrome-devtools-mcp@$package_version"
set -- --yes "$package" "--browser-url=$browser_url" --no-usage-statistics --no-performance-crux --redact-network-headers
[ "$full_tools" -eq 1 ] || set -- "$@" --slim

tmp_base=${TMPDIR:-/tmp}
tmp_dir=$(mktemp -d "$tmp_base/relaybridge-chrome-install.XXXXXX")
committed=0
codex_home_dir=${CODEX_HOME:-$HOME/.codex}
codex_config=$codex_home_dir/config.toml
claude_default_config=$HOME/.claude.json
claude_alt_config=
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then claude_alt_config=$CLAUDE_CONFIG_DIR/.claude.json; fi

snapshot() {
  source_path=$1
  snapshot_name=$2
  if [ -f "$source_path" ]; then
    cp -p "$source_path" "$tmp_dir/$snapshot_name.bytes"
    printf '%s\n' present > "$tmp_dir/$snapshot_name.state"
  else
    printf '%s\n' absent > "$tmp_dir/$snapshot_name.state"
  fi
}

restore() {
  target_path=$1
  snapshot_name=$2
  state=$(sed -n '1p' "$tmp_dir/$snapshot_name.state")
  if [ "$state" = present ]; then
    mkdir -p "$(dirname "$target_path")"
    cp -p "$tmp_dir/$snapshot_name.bytes" "$target_path"
  else
    rm -f "$target_path"
  fi
}

if [ "$skip_codex" -eq 0 ]; then snapshot "$codex_config" codex; fi
if [ "$skip_claude" -eq 0 ]; then
  snapshot "$claude_default_config" claude-default
  if [ -n "$claude_alt_config" ] && [ "$claude_alt_config" != "$claude_default_config" ]; then
    snapshot "$claude_alt_config" claude-alt
  fi
fi

on_exit() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$committed" -eq 0 ]; then
    if [ "$skip_codex" -eq 0 ]; then restore "$codex_config" codex || true; fi
    if [ "$skip_claude" -eq 0 ]; then
      restore "$claude_default_config" claude-default || true
      if [ -n "$claude_alt_config" ] && [ "$claude_alt_config" != "$claude_default_config" ]; then
        restore "$claude_alt_config" claude-alt || true
      fi
    fi
    printf '%s\n' '[RelayBridge] Chrome MCP registration failed; client configurations were restored.' >&2
  fi
  case "$tmp_dir" in "$tmp_base"/relaybridge-chrome-install.*) rm -rf "$tmp_dir" ;; esac
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

configure_codex_approval() {
  section="[mcp_servers.$name]"
  approval=writes
  [ "$full_permissions" -eq 0 ] || approval=approve
  configured=$tmp_dir/codex-config.toml
  awk -v section="$section" -v approval="$approval" '
    BEGIN { inside = 0; found = 0 }
    $0 == section {
      found = 1; inside = 1; print
      print "startup_timeout_sec = 30"
      print "tool_timeout_sec = 300"
      print "required = false"
      print "default_tools_approval_mode = \"" approval "\""
      next
    }
    inside && /^\[/ { inside = 0 }
    inside && /^(startup_timeout_sec|tool_timeout_sec|required|default_tools_approval_mode)[[:space:]]*=/ { next }
    { print }
    END { if (!found) exit 42 }
  ' "$codex_config" > "$configured" || fail "Codex created no $section section"
  cp "$configured" "$codex_config"
  awk -v section="$section" -v approval="$approval" '
    $0 == section { inside = 1; next }
    inside && /^\[/ { inside = 0 }
    inside && $0 == "startup_timeout_sec = 30" { startup = 1 }
    inside && $0 == "tool_timeout_sec = 300" { timeout = 1 }
    inside && $0 == "required = false" { optional = 1 }
    inside && $0 == "default_tools_approval_mode = \"" approval "\"" { approved = 1 }
    END { exit(startup && timeout && optional && approved ? 0 : 1) }
  ' "$codex_config" || fail 'Codex Chrome MCP policy did not verify'
}

if [ "$skip_codex" -eq 0 ]; then
  "$codex_path" mcp remove "$name" >/dev/null 2>&1 || true
  "$codex_path" mcp add "$name" \
    --env CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1 \
    --env CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 \
    -- "$npx_path" "$@" >/dev/null
  configure_codex_approval
  "$codex_path" mcp get "$name" --json > "$tmp_dir/codex-get.json"
  EXPECTED_PACKAGE=$package EXPECTED_URL="--browser-url=$browser_url" EXPECTED_SLIM=$((1 - full_tools)) \
    "$node_path" -e '
      const fs = require("fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const transport = value.transport || value;
      const args = Array.isArray(transport.args) ? transport.args : [];
      const env = transport.env || {};
      if (!args.includes(process.env.EXPECTED_PACKAGE) || !args.includes(process.env.EXPECTED_URL) ||
          !args.includes("--no-usage-statistics") || !args.includes("--no-performance-crux") ||
          !args.includes("--redact-network-headers")) process.exit(2);
      if ((process.env.EXPECTED_SLIM === "1") !== args.includes("--slim")) process.exit(3);
      if (env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS !== "1" ||
          env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS !== "1") process.exit(4);
    ' "$tmp_dir/codex-get.json" || fail "Codex Chrome MCP '$name' did not verify"
  printf "[RelayBridge] Codex Chrome MCP '%s' registered.\n" "$name"
fi

if [ "$skip_claude" -eq 0 ]; then
  "$claude_path" mcp remove --scope user "$name" >/dev/null 2>&1 || true
  "$claude_path" mcp add --scope user "$name" \
    -e CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1 \
    -e CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1 \
    -- "$npx_path" "$@" >/dev/null
  "$claude_path" mcp get "$name" > "$tmp_dir/claude-get.txt"
  grep -F "$package" "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude Chrome MCP '$name' has the wrong package"
  grep -F -- "--browser-url=$browser_url" "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude Chrome MCP '$name' has the wrong browser URL"
  grep -F -- '--no-usage-statistics' "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude Chrome MCP '$name' did not disable usage statistics"
  grep -F -- '--no-performance-crux' "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude Chrome MCP '$name' did not disable CrUX"
  grep -F -- '--redact-network-headers' "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude Chrome MCP '$name' did not redact network headers"
  grep -F 'CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS' "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude Chrome MCP '$name' lost its telemetry environment guard"
  grep -F 'CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS' "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude Chrome MCP '$name' lost its update-check environment guard"
  if [ "$full_tools" -eq 0 ]; then
    grep -F -- '--slim' "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude Chrome MCP '$name' is not in slim mode"
  elif grep -F -- '--slim' "$tmp_dir/claude-get.txt" >/dev/null; then
    fail "Claude Chrome MCP '$name' unexpectedly retained slim mode"
  fi
  printf "[RelayBridge] Claude Chrome MCP '%s' registered at user scope.\n" "$name"
fi

committed=1
printf '%s\n' '[RelayBridge] Chrome MCP registration complete. Restart open Codex and Claude clients.'

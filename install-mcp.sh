#!/bin/sh

# Register this exact RelayBridge checkout with local Codex and Claude CLIs.
# Configuration changes are backed up and rolled back together on failure.
set -eu
umask 077

name=relaybridge
bridge_url=http://127.0.0.1:8787
skip_codex=0
skip_claude=0
full_permissions=0

usage() {
  printf '%s\n' \
    'Usage: ./install-mcp.sh [--name NAME] [--bridge-url URL] [--skip-codex] [--skip-claude] [--full-permissions]' \
    '' \
    'URL must be loopback HTTP: http://127.0.0.1 or http://127.0.0.1:PORT.' \
    '--full-permissions starts in full-permission mode and preserves that explicit opt-in.'
}

fail() {
  printf '[RelayBridge] %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)
      [ "$#" -ge 2 ] || fail '--name requires a value'
      name=$2
      shift 2
      ;;
    --bridge-url)
      [ "$#" -ge 2 ] || fail '--bridge-url requires a value'
      bridge_url=$2
      shift 2
      ;;
    --skip-codex)
      skip_codex=1
      shift
      ;;
    --skip-claude)
      skip_claude=1
      shift
      ;;
    --full-permissions)
      full_permissions=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

case "$name" in
  ''|*[!A-Za-z0-9_-]*) fail 'MCP name may contain only letters, digits, underscore, and hyphen' ;;
esac

case "$bridge_url" in
  http://127.0.0.1) ;;
  http://127.0.0.1:*)
    port=${bridge_url#http://127.0.0.1:}
    case "$port" in ''|*[!0-9]*) fail 'invalid loopback port' ;; esac
    [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null || fail 'loopback port must be 1-65535'
    ;;
  *) fail 'refusing non-loopback MCP URL' ;;
esac

script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
mcp_server=$script_dir/mcp/server.mjs
token_file=$script_dir/.bridge-token
timeout_policy=$script_dir/config/timeout-policy.json

[ -f "$mcp_server" ] || fail "MCP server not found: $mcp_server"
[ -f "$timeout_policy" ] || fail "timeout policy not found: $timeout_policy"
node_path=$(command -v node 2>/dev/null || true)
[ -n "$node_path" ] || fail 'node is not installed or is not on PATH'

if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
  case "$script_dir" in /mnt|/mnt/*) fail 'move RelayBridge under the WSL Linux home filesystem; /mnt checkouts are refused' ;; esac
  case "$node_path" in /mnt|/mnt/*) fail 'install Linux-native Node inside WSL; Windows Node through /mnt is refused' ;; esac
fi

validate_token_file() {
  token_value=$(tr -d '\r\n' < "$1")
  case "$token_value" in ''|*[!A-Fa-f0-9]*) valid_token=0 ;; *) valid_token=1 ;; esac
  [ "$valid_token" -eq 1 ] && [ "${#token_value}" -eq 64 ] || {
    unset token_value
    return 1
  }
  unset token_value
}

token_created=0
if [ ! -f "$token_file" ]; then
  token_tmp=$(mktemp "$script_dir/.bridge-token.tmp.XXXXXX")
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "$token_tmp"
  elif [ -r /dev/urandom ]; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$token_tmp"
    printf '\n' >> "$token_tmp"
  else
    rm -f "$token_tmp"
    fail 'cannot create a cryptographically random capability token'
  fi
  validate_token_file "$token_tmp" || {
    rm -f "$token_tmp"
    fail 'generated capability token failed validation'
  }
  chmod 600 "$token_tmp"
  mv "$token_tmp" "$token_file"
  token_created=1
else
  validate_token_file "$token_file" || fail "existing capability token is invalid: $token_file"
  chmod 600 "$token_file"
fi

mcp_tool_timeout_sec=$(
  "$node_path" -e '
    const fs = require("fs");
    const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const values = [p.oneShotMaxMs, p.transportGraceMs, p.mcpHostGraceMs];
    if (!values.every(Number.isFinite)) process.exit(2);
    const seconds = Math.ceil(values.reduce((a, b) => a + b, 0) / 1000);
    if (!Number.isInteger(seconds) || seconds < 1) process.exit(3);
    process.stdout.write(String(seconds));
  ' "$timeout_policy"
) || fail "invalid timeout policy: $timeout_policy"
case "$mcp_tool_timeout_sec" in ''|*[!0-9]*) fail 'computed MCP timeout is invalid' ;; esac

tmp_base=${TMPDIR:-/tmp}
tmp_dir=$(mktemp -d "$tmp_base/relaybridge-mcp-install.XXXXXX")
committed=0

codex_home_dir=${CODEX_HOME:-$HOME/.codex}
codex_config=$codex_home_dir/config.toml
claude_default_config=$HOME/.claude.json
claude_alt_config=
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  claude_alt_config=$CLAUDE_CONFIG_DIR/.claude.json
fi

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

snapshot "$codex_config" codex
snapshot "$claude_default_config" claude-default
if [ -n "$claude_alt_config" ] && [ "$claude_alt_config" != "$claude_default_config" ]; then
  snapshot "$claude_alt_config" claude-alt
fi

on_exit() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$committed" -eq 0 ]; then
    restore "$codex_config" codex || true
    restore "$claude_default_config" claude-default || true
    if [ -n "$claude_alt_config" ] && [ "$claude_alt_config" != "$claude_default_config" ]; then
      restore "$claude_alt_config" claude-alt || true
    fi
    if [ "$token_created" -eq 1 ]; then
      rm -f "$token_file"
    fi
    printf '%s\n' '[RelayBridge] registration failed; client configuration was restored from private snapshots.' >&2
  fi
  case "$tmp_dir" in "$tmp_base"/relaybridge-mcp-install.*) rm -rf "$tmp_dir" ;; esac
  exit "$status"
}
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

configure_codex_timeout() {
  section="[mcp_servers.$name]"
  configured=$tmp_dir/codex-config.toml
  approval=writes
  [ "$full_permissions" -eq 0 ] || approval=approve
  awk -v section="$section" -v timeout="$mcp_tool_timeout_sec" -v approval="$approval" '
    BEGIN { inside = 0; found = 0 }
    $0 == section {
      found = 1
      inside = 1
      print
      print "startup_timeout_sec = 15"
      print "tool_timeout_sec = " timeout
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

  awk -v section="$section" -v timeout="$mcp_tool_timeout_sec" -v approval="$approval" '
    $0 == section { inside = 1; next }
    inside && /^\[/ { inside = 0 }
    inside && $0 == "tool_timeout_sec = " timeout { found = 1 }
    inside && $0 == "default_tools_approval_mode = \"" approval "\"" { approved = 1 }
    END { exit(found && approved ? 0 : 1) }
  ' "$codex_config" || fail 'Codex MCP tool timeout did not verify'
}

if [ "$skip_codex" -eq 0 ]; then
  command -v codex >/dev/null 2>&1 || fail 'Codex CLI is not installed or is not on PATH'
  codex mcp remove "$name" >/dev/null 2>&1 || true
  if [ "$full_permissions" -eq 1 ]; then
    codex mcp add "$name" \
      --env "RELAYBRIDGE_URL=$bridge_url" \
      --env "RELAYBRIDGE_TOKEN_FILE=$token_file" \
      --env 'RELAYBRIDGE_ALLOW_STICKY_DANGEROUS=1' \
      --env 'RELAYBRIDGE_START_FULL_PERMISSIONS=1' \
      -- "$node_path" "$mcp_server" >/dev/null
  else
    codex mcp add "$name" \
      --env "RELAYBRIDGE_URL=$bridge_url" \
      --env "RELAYBRIDGE_TOKEN_FILE=$token_file" \
      -- "$node_path" "$mcp_server" >/dev/null
  fi
  configure_codex_timeout
  codex mcp get "$name" --json > "$tmp_dir/codex-get.json"
  EXPECTED_SERVER=$mcp_server EXPECTED_URL=$bridge_url EXPECTED_TOKEN_FILE=$token_file EXPECTED_STICKY=$full_permissions \
    "$node_path" -e '
      const fs = require("fs");
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const transport = value.transport || value;
      const args = Array.isArray(transport.args) ? transport.args : [];
      const env = transport.env || {};
      if (!args.includes(process.env.EXPECTED_SERVER) ||
          env.RELAYBRIDGE_URL !== process.env.EXPECTED_URL ||
          env.RELAYBRIDGE_TOKEN_FILE !== process.env.EXPECTED_TOKEN_FILE) process.exit(2);
      const sticky = env.RELAYBRIDGE_ALLOW_STICKY_DANGEROUS;
      const startFull = env.RELAYBRIDGE_START_FULL_PERMISSIONS;
      if ((process.env.EXPECTED_STICKY === "1" && (sticky !== "1" || startFull !== "1")) ||
          (process.env.EXPECTED_STICKY !== "1" && (sticky !== undefined || startFull !== undefined))) process.exit(3);
    ' "$tmp_dir/codex-get.json" || fail "Codex MCP '$name' did not verify"
  printf "[RelayBridge] Codex MCP '%s' registered with a %ss tool timeout.\n" "$name" "$mcp_tool_timeout_sec"
fi

if [ "$skip_claude" -eq 0 ]; then
  command -v claude >/dev/null 2>&1 || fail 'Claude CLI is not installed or is not on PATH'
  claude mcp remove --scope user "$name" >/dev/null 2>&1 || true
  if [ "$full_permissions" -eq 1 ]; then
    claude mcp add --scope user "$name" \
      -e "RELAYBRIDGE_URL=$bridge_url" \
      -e "RELAYBRIDGE_TOKEN_FILE=$token_file" \
      -e 'RELAYBRIDGE_ALLOW_STICKY_DANGEROUS=1' \
      -e 'RELAYBRIDGE_START_FULL_PERMISSIONS=1' \
      -- "$node_path" "$mcp_server" >/dev/null
  else
    claude mcp add --scope user "$name" \
      -e "RELAYBRIDGE_URL=$bridge_url" \
      -e "RELAYBRIDGE_TOKEN_FILE=$token_file" \
      -- "$node_path" "$mcp_server" >/dev/null
  fi
  claude mcp get "$name" > "$tmp_dir/claude-get.txt"
  grep -F "$mcp_server" "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude MCP '$name' has the wrong server path"
  grep -F "$bridge_url" "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude MCP '$name' has the wrong loopback URL"
  grep -F "$token_file" "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude MCP '$name' has the wrong token-file path"
  if [ "$full_permissions" -eq 1 ]; then
    grep -F 'RELAYBRIDGE_ALLOW_STICKY_DANGEROUS' "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude MCP '$name' did not retain the full-permissions opt-in"
    grep -F 'RELAYBRIDGE_START_FULL_PERMISSIONS' "$tmp_dir/claude-get.txt" >/dev/null || fail "Claude MCP '$name' did not retain the full-permissions startup opt-in"
  elif grep -F 'RELAYBRIDGE_ALLOW_STICKY_DANGEROUS' "$tmp_dir/claude-get.txt" >/dev/null; then
    fail "Claude MCP '$name' unexpectedly retained full permissions"
  elif grep -F 'RELAYBRIDGE_START_FULL_PERMISSIONS' "$tmp_dir/claude-get.txt" >/dev/null; then
    fail "Claude MCP '$name' unexpectedly starts with full permissions"
  fi
  printf "[RelayBridge] Claude MCP '%s' registered.\n" "$name"
fi

committed=1
printf '%s\n' '[RelayBridge] Registration complete. Restart open Codex and Claude clients.'

#!/bin/sh

# Link the pipeline skill and role definitions from this checkout into the
# current user's Codex and Claude configuration. Existing targets are retained
# as timestamped backups; token or credential contents are never read.
set -eu
umask 077

register_mcp=0
register_chrome=0
full_permissions=0

usage() {
  printf '%s\n' 'Usage: ./install-skill.sh [--register-mcp] [--register-chrome] [--full-permissions]'
}

fail() {
  printf '[RelayBridge] %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --register-mcp) register_mcp=1; shift ;;
    --register-chrome) register_chrome=1; shift ;;
    --full-permissions) full_permissions=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

[ -n "${HOME:-}" ] || fail 'HOME is not set'
[ "$full_permissions" -eq 0 ] || { [ "$register_mcp" -eq 1 ] || [ "$register_chrome" -eq 1 ]; } || fail '--full-permissions requires an MCP registration option'
script_dir=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
if { [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; }; then
  case "$script_dir" in /mnt|/mnt/*) fail 'move RelayBridge under the WSL Linux home filesystem before installing global links' ;; esac
fi
skill_source=$script_dir/skills/codex-claude-pipeline
codex_agents_source=$script_dir/.codex/agents
claude_agents_source=$script_dir/.claude/agents

[ -f "$skill_source/SKILL.md" ] || fail "pipeline skill not found: $skill_source"
[ -f "$skill_source/agents/openai.yaml" ] || fail 'pipeline skill UI metadata is missing'
[ -d "$codex_agents_source" ] || fail 'Codex role directory is missing'
[ -d "$claude_agents_source" ] || fail 'Claude role directory is missing'

stamp=$(date -u '+%Y%m%dT%H%M%SZ')

install_link() {
  source_path=$1
  target_path=$2
  target_parent=$(dirname "$target_path")
  mkdir -p "$target_parent"

  if [ -L "$target_path" ] && [ "$(readlink "$target_path")" = "$source_path" ]; then
    [ -e "$target_path" ] || fail "existing link is broken: $target_path"
    printf '[RelayBridge] verified %s\n' "$target_path"
    return
  fi

  backup_path=
  if [ -e "$target_path" ] || [ -L "$target_path" ]; then
    backup_path=$target_path.backup.$stamp.$$
    [ ! -e "$backup_path" ] && [ ! -L "$backup_path" ] || fail "backup already exists: $backup_path"
    mv "$target_path" "$backup_path"
    printf '[RelayBridge] backed up %s to %s\n' "$target_path" "$backup_path"
  fi

  if ! ln -s "$source_path" "$target_path"; then
    if [ -n "$backup_path" ]; then mv "$backup_path" "$target_path"; fi
    fail "could not link $target_path"
  fi
  if [ ! -L "$target_path" ] || [ "$(readlink "$target_path")" != "$source_path" ] || [ ! -e "$target_path" ]; then
    rm -f "$target_path"
    if [ -n "$backup_path" ]; then mv "$backup_path" "$target_path"; fi
    fail "link verification failed: $target_path"
  fi
  printf '[RelayBridge] linked %s\n' "$target_path"
}

# ~/.agents/skills is the current shared Codex skill location. Link the same
# source into the legacy/current-host ~/.codex/skills location for compatibility.
# Claude Code uses its own ~/.claude/skills directory.
install_link "$skill_source" "$HOME/.agents/skills/codex-claude-pipeline"
install_link "$skill_source" "$HOME/.codex/skills/codex-claude-pipeline"
install_link "$skill_source" "$HOME/.claude/skills/codex-claude-pipeline"

for source_path in "$codex_agents_source"/*.toml; do
  [ -f "$source_path" ] || continue
  install_link "$source_path" "$HOME/.codex/agents/$(basename "$source_path")"
done

for source_path in "$claude_agents_source"/*.md; do
  [ -f "$source_path" ] || continue
  install_link "$source_path" "$HOME/.claude/agents/$(basename "$source_path")"
done

if [ "$register_mcp" -eq 1 ]; then
  if [ "$full_permissions" -eq 1 ]; then
    "$script_dir/install-mcp.sh" --full-permissions
  else
    "$script_dir/install-mcp.sh"
  fi
fi

if [ "$register_chrome" -eq 1 ]; then
  if [ "$full_permissions" -eq 1 ]; then
    "$script_dir/install-chrome-mcp.sh" --full-permissions
  else
    "$script_dir/install-chrome-mcp.sh"
  fi
fi

printf '%s\n' '[RelayBridge] Pipeline skill and roles verified. Start fresh Codex and Claude sessions to load them.'

#!/usr/bin/env bash
# Migrates a RelayBridge cli-config.json in place to the uncapped-deadlines
# policy: removes the wall-clock ceilings that used to stop or refuse a run
# purely for elapsed time. Supervisor kills/progress check-ins are a separate
# lane and are untouched by this script.
#
# Usage:
#   scripts/migrate-uncap-config.sh [--config PATH] --backup-dir DIR [--dry-run]
#
# Changes applied:
#   - ._supervisor.providerBudget.* -> null (all fields, any set)
#   - ._supervisor.hardCapMs -> deleted
#   - <provider>.supervisor.providerBudgetByTaskTier -> deleted, for every
#     provider that has one (not just claude/claude_fable)
#   - every provider's safe/dangerous/oneshot_safe/oneshot_dangerous args
#     array: "--max-turns" and its following value are removed, wherever
#     they appear
#
# Never run this against the real config directly without a backup: pass
# --backup-dir (required) and use --dry-run first to review the diff.

set -euo pipefail

CONFIG_PATH="${HOME}/.config/relaybridge/cli-config.json"
BACKUP_DIR=""
DRY_RUN=0

usage() {
  echo "Usage: $0 [--config PATH] --backup-dir DIR [--dry-run]" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      [ $# -ge 2 ] || usage
      CONFIG_PATH="$2"
      shift 2
      ;;
    --backup-dir)
      [ $# -ge 2 ] || usage
      BACKUP_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [ -z "$BACKUP_DIR" ]; then
  echo "error: --backup-dir is required" >&2
  usage
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq is required" >&2
  exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "error: config not found: $CONFIG_PATH" >&2
  exit 1
fi

if ! jq -e '.' "$CONFIG_PATH" >/dev/null 2>&1; then
  echo "error: $CONFIG_PATH is not valid JSON" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
BACKUP_PATH="${BACKUP_DIR%/}/cli-config.json.$(date -u +%Y%m%dT%H%M%SZ).bak"
cp -p "$CONFIG_PATH" "$BACKUP_PATH"
echo "backed up $CONFIG_PATH -> $BACKUP_PATH"

JQ_FILTER='
  # 1. _supervisor.providerBudget.* -> null (keys stay, values nulled)
  (if has("_supervisor") and (._supervisor | has("providerBudget")) then
    ._supervisor.providerBudget |= (with_entries(.value = null))
  else . end)
  # 2. _supervisor.hardCapMs -> deleted
  | (if has("_supervisor") then del(._supervisor.hardCapMs) else . end)
  # 3. every provider'"'"'s supervisor.providerBudgetByTaskTier -> deleted
  | with_entries(
      if (.value | type) == "object" and (.value | has("supervisor"))
         and (.value.supervisor | type) == "object"
         and (.value.supervisor | has("providerBudgetByTaskTier"))
      then .value.supervisor |= del(.providerBudgetByTaskTier)
      else . end
    )
  # 4. strip "--max-turns" and its following value from every provider'"'"'s
  #    safe/dangerous/oneshot_safe/oneshot_dangerous arg arrays
  | with_entries(
      if (.value | type) == "object" then
        .value |= with_entries(
          if (.key as $k | ["safe","dangerous","oneshot_safe","oneshot_dangerous"] | index($k))
             and (.value | type) == "array"
          then
            .value |= (
              . as $arr
              | [range(0; length) as $i
                  | select(
                      ($arr[$i] != "--max-turns")
                      and ($i == 0 or $arr[$i-1] != "--max-turns")
                    )
                  | $arr[$i]
                ]
            )
          else . end
        )
      else . end
    )
'

TMP_OUT="$(mktemp "${TMPDIR:-/tmp}/migrate-uncap-config.XXXXXX.json")"
trap 'rm -f "$TMP_OUT"' EXIT

if ! jq "$JQ_FILTER" "$CONFIG_PATH" > "$TMP_OUT"; then
  echo "error: jq transform failed" >&2
  exit 1
fi

if ! jq -e '.' "$TMP_OUT" >/dev/null 2>&1; then
  echo "error: migrated output is not valid JSON; aborting, original left untouched" >&2
  exit 1
fi

echo "--- diff summary (removed/changed keys) ---"
# diff exits 1 when it finds differences (the expected case here), and with
# `set -o pipefail` that would otherwise trip `set -e` and silently kill the
# script right here, before the migrated file is ever written back. The
# `|| true` absorbs that expected non-zero status; a real jq/grep failure
# earlier in the pipe would already have aborted above.
CHANGED_LINES="$(diff <(jq -S '.' "$CONFIG_PATH") <(jq -S '.' "$TMP_OUT") | grep -c '^[<>]' || true)"
echo "${CHANGED_LINES:-0} changed lines"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry-run: not writing changes to $CONFIG_PATH (backup retained at $BACKUP_PATH)"
  exit 0
fi

# Atomic replace: same filesystem as CONFIG_PATH, then rename.
FINAL_TMP="$(mktemp "$(dirname "$CONFIG_PATH")/.cli-config.json.XXXXXX")"
cp "$TMP_OUT" "$FINAL_TMP"
mv -f "$FINAL_TMP" "$CONFIG_PATH"
echo "migrated $CONFIG_PATH (backup at $BACKUP_PATH)"

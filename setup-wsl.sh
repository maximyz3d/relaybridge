#!/usr/bin/env bash
# RelayBridge WSL/Linux bootstrap.
#
# Run INSIDE WSL (Ubuntu) or any Debian-family Linux:
#   bash setup-wsl.sh
#
# Idempotent: safe to re-run, skips anything already present. Ends with the
# GitHub device-flow sign-in for maximyz3d — it prints a link and a code.
set -euo pipefail

REPO_URL="https://github.com/maximyz3d/relaybridge.git"
REPO_DIR="$HOME/projects/relaybridge"
# Was pinned to feat/usage-fuel-gauge — a branch 41 commits behind main that
# predates the POSIX port, so a machine bootstrapped from it came up with every
# seat reported "not installed". Track the default branch; set
# RELAYBRIDGE_BRANCH=<name> to bootstrap a topic branch on purpose.
BRANCH="${RELAYBRIDGE_BRANCH:-main}"
NODE_MAJOR=22

step() { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }

case "$REPO_DIR" in
  /mnt|/mnt/*)
    echo "ERROR: RELAYBRIDGE must live on WSL's native Linux filesystem (for example ~/projects), not $REPO_DIR." >&2
    exit 1
    ;;
esac

# Privileged installs are best-effort, not preconditions. On a box provisioned
# without passwordless sudo — node and gh installed as tarballs under ~/.local
# and ~/.npm-global — the first `sudo apt-get update` failed and `set -e` killed
# the script before the npm-prefix, clone and start steps, which are the only
# parts such a machine still needs. Probe once, then report what was skipped
# instead of aborting.
# Three states, not two. `sudo -n true` only succeeds with PASSWORDLESS sudo,
# but the default fresh Ubuntu/WSL user is in the sudo group WITH a password —
# treating that as "no sudo" would skip apt for the most common install of all
# and tell a perfectly capable operator to run the commands by hand.
SUDO_PROMPTS=0
if [[ $EUID -eq 0 ]]; then
  CAN_ROOT=1
elif ! command -v sudo >/dev/null 2>&1; then
  CAN_ROOT=0
elif sudo -n true 2>/dev/null; then
  CAN_ROOT=1                      # passwordless
elif [[ -t 0 ]] || (: < /dev/tty) 2>/dev/null; then
  CAN_ROOT=1; SUDO_PROMPTS=1      # sudo exists and there is a tty to prompt on
else
  CAN_ROOT=0                      # piped install, password required: cannot ask
fi
if [[ $SUDO_PROMPTS -eq 1 ]]; then
  echo "sudo will prompt for your password during the package steps."
fi
as_root() { if [[ $EUID -eq 0 ]]; then "$@"; else sudo "$@"; fi; }

step "System packages"
if [[ $CAN_ROOT -eq 1 ]]; then
  as_root apt-get update -y || echo "WARN: apt-get update failed — continuing with what is installed"
  as_root apt-get install -y curl git build-essential python3 ca-certificates \
    || echo "WARN: apt-get install failed — continuing; node-pty needs build-essential + python3"
else
  echo "no usable sudo — skipping apt. Install these by hand if node-pty fails to build:"
  echo "  sudo apt-get install -y curl git build-essential python3 ca-certificates"
fi

step "Node.js $NODE_MAJOR (NodeSource)"
if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == v$NODE_MAJOR.* ]]; then
  echo "node $(node -v) already installed"
elif [[ $CAN_ROOT -eq 1 ]]; then
  if [[ $EUID -eq 0 ]]; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  fi
  as_root apt-get install -y nodejs
elif command -v node >/dev/null 2>&1; then
  # A tarball node under ~/.local hosts the bridge fine: package.json declares
  # engines node >=20.3, not a v22 pin. Do not fail a working machine over it.
  echo "node $(node -v) found and no sudo to change it — continuing with it"
else
  echo "ERROR: node is missing and there is no sudo to install it."
  echo "Install Node $NODE_MAJOR into your own prefix first (nvm, or a nodejs.org"
  echo "tarball unpacked into ~/.local), then re-run this script."
  exit 1
fi
node -v; npm -v
case "$(command -v node)" in
  /mnt|/mnt/*)
    echo 'ERROR: Windows-side Node was found through /mnt. Install Linux-native Node inside WSL.' >&2
    exit 1
    ;;
esac

step "GitHub CLI"
if command -v gh >/dev/null 2>&1; then
  gh --version | head -1
elif [[ $CAN_ROOT -eq 1 ]]; then
  (type -p wget >/dev/null || as_root apt-get install -y wget)
  as_root mkdir -p -m 755 /etc/apt/keyrings
  wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | as_root tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
  as_root chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | as_root tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  { as_root apt-get update -y && as_root apt-get install -y gh; } \
    || echo "WARN: gh install failed — install it by hand or use a tarball in ~/.local/bin"
  gh --version | head -1
else
  echo "gh is missing and there is no sudo to install it. The bridge does not need"
  echo "gh — only the sign-in step below does. Install it later from"
  echo "https://github.com/cli/cli/releases (a tarball into ~/.local works)."
fi

step "Model CLIs (global, in your own prefix — no sudo npm)"
mkdir -p "$HOME/.npm-global"
npm config set prefix "$HOME/.npm-global"
grep -q 'npm-global' "$HOME/.profile" 2>/dev/null || \
  echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> "$HOME/.profile"
export PATH="$HOME/.npm-global/bin:$PATH"
# The bridge spawns these through a LOGIN shell precisely so this PATH works.
for pkg in @anthropic-ai/claude-code @openai/codex @google/gemini-cli; do
  name="${pkg##*/}"
  if command -v "${name%-cli}" >/dev/null 2>&1 || command -v "$name" >/dev/null 2>&1; then
    echo "$pkg already installed"
  else
    npm install -g "$pkg" || echo "WARN: $pkg failed to install — sign-in/retry later, the bridge treats a missing CLI as a not-ready seat, not an error"
  fi
done

step "GitHub sign-in (maximyz3d) — device flow"
if ! command -v gh >/dev/null 2>&1; then
  echo "gh not installed — skipping sign-in; git over HTTPS will prompt instead."
elif gh auth status >/dev/null 2>&1; then
  echo "already signed in:"; gh auth status 2>&1 | head -3
  gh auth setup-git || echo "WARN: gh auth setup-git failed — git may prompt for credentials"
else
  echo "A link and one-time code will appear below."
  echo "Open the link ANYWHERE (phone is fine), sign in as maximyz3d, enter the code."
  # --web prints https://github.com/login/device plus the XXXX-XXXX code and waits.
  gh auth login --hostname github.com --git-protocol https --web
  gh auth setup-git || echo "WARN: gh auth setup-git failed — git may prompt for credentials"
fi

step "Repository"
mkdir -p "$(dirname "$REPO_DIR")"
if [[ -d "$REPO_DIR/.git" ]]; then
  git -C "$REPO_DIR" fetch origin
else
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
git checkout "$BRANCH"
git pull --rebase origin "$BRANCH"

step "Dependencies + tests"
npm install --no-audit --no-fund
# node-pty is an optionalDependency, so npm exits 0 even when its native build
# fails (it needs build-essential + python3). The bridge then silently falls
# back to pipe mode, where the dashboard's interactive sign-in terminals have no
# TTY to present. Report it here instead of letting it be discovered at sign-in.
node -e "try { require('node-pty'); console.log('node-pty: built — interactive sign-in terminals available'); } catch { console.log('node-pty: NOT built — the bridge will run in pipe mode and interactive sign-in terminals will not work. Fix with: sudo apt-get install -y build-essential python3 && npm rebuild node-pty'); }"
npm test && TESTS=ok || TESTS=FAILED
echo "tests: $TESTS"

step "Start the bridge"
chmod +x start.sh
RELAYBRIDGE_REMOTE_MCP=1 ./start.sh

# start.sh binds ${RELAYBRIDGE_PORT:-${PORT:-8787}}. Printing a hardcoded 8787
# sent anyone running the documented two-bridge topology (Windows 8787 + WSL
# 8788) to the other bridge's dashboard.
DASHBOARD_PORT="${RELAYBRIDGE_PORT:-${PORT:-8787}}"
echo
echo "Done. Dashboard: http://localhost:$DASHBOARD_PORT  (reachable from Windows too — WSL forwards localhost)"
echo "Stop with: ./start.sh --stop    Foreground: ./start.sh --fg"

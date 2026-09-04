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
# Until the port lands on main, default to the branch that actually contains
# the WSL/Linux implementation. Operators can still test another ref without
# editing the bootstrap by setting RELAYBRIDGE_BRANCH.
BRANCH="${RELAYBRIDGE_BRANCH:-feat/wsl-port-on-main}"
NODE_MAJOR=22

step() { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }

step "System packages"
sudo apt-get update -y
sudo apt-get install -y curl git build-essential python3 ca-certificates

step "Node.js $NODE_MAJOR (NodeSource)"
if command -v node >/dev/null 2>&1 && [[ "$(node -v)" == v$NODE_MAJOR.* ]]; then
  echo "node $(node -v) already installed"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v; npm -v

step "GitHub CLI"
if ! command -v gh >/dev/null 2>&1; then
  (type -p wget >/dev/null || sudo apt-get install -y wget)
  sudo mkdir -p -m 755 /etc/apt/keyrings
  wget -qO- https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null
  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt-get update -y && sudo apt-get install -y gh
fi
gh --version | head -1

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
if gh auth status >/dev/null 2>&1; then
  echo "already signed in:"; gh auth status 2>&1 | head -3
else
  echo "A link and one-time code will appear below."
  echo "Open the link ANYWHERE (phone is fine), sign in as maximyz3d, enter the code."
  # --web prints https://github.com/login/device plus the XXXX-XXXX code and waits.
  gh auth login --hostname github.com --git-protocol https --web
fi
gh auth setup-git

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
npm test && TESTS=ok || TESTS=FAILED
echo "tests: $TESTS"

step "Start the bridge"
chmod +x start.sh
RELAYBRIDGE_REMOTE_MCP=1 ./start.sh

echo
echo "Done. Dashboard: http://localhost:8787  (reachable from Windows too — WSL forwards localhost)"
echo "Stop with: ./start.sh --stop    Foreground: ./start.sh --fg"

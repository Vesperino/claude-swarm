#!/usr/bin/env bash
# Installs the swarm skills into ~/.claude/skills so they are available as
# plain /swarm, /swarm-init and /swarm-role commands in every project.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skills"
DEST="${HOME}/.claude/skills"
mkdir -p "$DEST"
for s in swarm swarm-init swarm-role; do
  if [ -d "$DEST/$s" ]; then
    echo "~/.claude/skills/$s already exists - updating in place"
    rm -rf "$DEST/$s"
  fi
  cp -r "$SRC/$s" "$DEST/$s"
  echo "installed $s -> $DEST/$s"
done
# Codex CLI: same skill, poll-driven adapter (see the Codex section of SKILL.md)
if [ -d "$HOME/.codex" ]; then
  mkdir -p "$HOME/.codex/skills"
  rm -rf "$HOME/.codex/skills/swarm"
  cp -r "$SRC/swarm" "$HOME/.codex/skills/swarm"
  echo "installed swarm -> ~/.codex/skills/swarm (Codex CLI: invoke with \$swarm)"
fi
node --version >/dev/null 2>&1 || echo "WARNING: node not found on PATH - the board server needs Node >= 20.11"
echo "Done. Open any project in Claude Code and run: /swarm <your goal>"

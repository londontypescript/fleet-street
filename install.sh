#!/usr/bin/env bash
# Link this repo into Claude Code's mods folder as the usage-banner plugin.
#
#   ./install.sh              link the repo at ~/.claude/mods/usage-banner
#   ./install.sh --uninstall  remove that link (nothing else is touched)
#
# CLAUDE_MODS_DIR overrides ~/.claude/mods (used for testing).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MODS_DIR="${CLAUDE_MODS_DIR:-$HOME/.claude/mods}"
TARGET="$MODS_DIR/usage-banner"
BACKUP_DIR="$HOME/.claude/backups"

resolves_to_repo() {
  [ -e "$1" ] && [ "$(cd "$1" && pwd -P)" = "$REPO" ]
}

if [ "${1:-}" = "--uninstall" ]; then
  if [ -L "$TARGET" ] && resolves_to_repo "$TARGET"; then
    rm "$TARGET"
    echo "Removed link $TARGET"
  elif [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
    echo "$TARGET is not a link to this repo; leaving it alone." >&2
    exit 1
  else
    echo "Nothing to remove: $TARGET does not exist."
  fi
  exit 0
fi

mkdir -p "$MODS_DIR"

if [ -L "$TARGET" ]; then
  if resolves_to_repo "$TARGET"; then
    echo "Already installed: $TARGET -> $REPO"
  else
    echo "$TARGET is a link to somewhere else ($(readlink "$TARGET")); not replacing it." >&2
    exit 1
  fi
else
  if [ -e "$TARGET" ]; then
    # A real folder is in the way: move it aside, outside the mods folder, never delete it.
    mkdir -p "$BACKUP_DIR"
    SAVED="$BACKUP_DIR/usage-banner.$(date +%Y%m%d-%H%M%S)"
    mv "$TARGET" "$SAVED"
    echo "Moved the existing folder to $SAVED"
  fi
  ln -s "$REPO" "$TARGET"
  echo "Linked $TARGET -> $REPO"
fi

# The plugin loads through CLAUDE_CODE_PLUGIN_DIRS; say so if settings.json doesn't name the path yet.
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ] && grep -q "$TARGET" "$SETTINGS"; then
  echo "settings.json already loads $TARGET."
else
  echo
  echo "Add this to the \"env\" block of $SETTINGS so Claude Code loads it:"
  echo "  \"CLAUDE_CODE_PLUGIN_DIRS\": \"$TARGET\""
fi

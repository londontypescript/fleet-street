#!/usr/bin/env bash
# Link this repo into Claude Code's mods folder as the fleet-street plugin, and make settings.json load it.
#
#   ./install.sh              link the repo at ~/.claude/mods/fleet-street and add it to settings.json
#   ./install.sh --uninstall  remove that link and that settings.json entry (nothing else is touched)
#
# CLAUDE_MODS_DIR overrides ~/.claude/mods (used for testing).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MODS_DIR="${CLAUDE_MODS_DIR:-$HOME/.claude/mods}"
TARGET="$MODS_DIR/fleet-street"
BACKUP_DIR="$HOME/.claude/backups"
SETTINGS="$HOME/.claude/settings.json"

resolves_to_repo() {
  [ -e "$1" ] && [ "$(cd "$1" && pwd -P)" = "$REPO" ]
}

# settings.json names the plugin folders in env.CLAUDE_CODE_PLUGIN_DIRS, separated by ':'.
# Other entries in that list, and everything else in the file, are left as they are.
JQ_DIRS='def dirs: ((.env.CLAUDE_CODE_PLUGIN_DIRS // "") | split(":") | map(select(length > 0)));'
JQ_ADD="$JQ_DIRS"'
  .env = ((.env // {}) + {CLAUDE_CODE_PLUGIN_DIRS: ((dirs | if any(.[]; . == $t) then . else . + [$t] end) | join(":"))})'
JQ_REMOVE="$JQ_DIRS"'
  (dirs | map(select(. != $t))) as $d
  | if ($d | length) > 0 then .env.CLAUDE_CODE_PLUGIN_DIRS = ($d | join(":")) else del(.env.CLAUDE_CODE_PLUGIN_DIRS) end'

in_settings() {
  [ -f "$SETTINGS" ] && jq -e --arg t "$TARGET" "$JQ_DIRS"' any(dirs[]; . == $t)' "$SETTINGS" >/dev/null 2>&1
}

# $1 is the jq program. Backs settings.json up first, then replaces it in one step.
edit_settings() {
  mkdir -p "$BACKUP_DIR"
  local saved="$BACKUP_DIR/settings.json.$(date +%Y%m%d-%H%M%S)"
  cp "$SETTINGS" "$saved"
  if ! jq --arg t "$TARGET" "$1" "$SETTINGS" > "$SETTINGS.tmp"; then
    rm -f "$SETTINGS.tmp"
    echo "Could not edit $SETTINGS (is it valid JSON?); left it as it was." >&2
    exit 1
  fi
  mv "$SETTINGS.tmp" "$SETTINGS"
  echo "Backed up settings.json to $saved"
}

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is needed to edit settings.json (brew install jq)." >&2
  exit 1
fi

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
  if in_settings; then
    edit_settings "$JQ_REMOVE"
    echo "Removed $TARGET from CLAUDE_CODE_PLUGIN_DIRS in settings.json."
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
    SAVED="$BACKUP_DIR/fleet-street.$(date +%Y%m%d-%H%M%S)"
    mv "$TARGET" "$SAVED"
    echo "Moved the existing folder to $SAVED"
  fi
  ln -s "$REPO" "$TARGET"
  echo "Linked $TARGET -> $REPO"
fi

if in_settings; then
  echo "settings.json already loads $TARGET."
else
  [ -f "$SETTINGS" ] || { mkdir -p "$(dirname "$SETTINGS")"; echo '{}' > "$SETTINGS"; }
  edit_settings "$JQ_ADD"
  echo "Added $TARGET to CLAUDE_CODE_PLUGIN_DIRS in settings.json."
fi
echo "Start a new Claude Code session to pick it up."

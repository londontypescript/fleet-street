# fleet-street

Usage and Status Banner Plugin for Claude

**Row 1:** 5-hour and weekly usage bars with time to reset, context size, and a prompt-cache countdown.
**Row 2:** git branch on the left, session timer on the right, and in the middle the running subagents and
background tasks. When there are none, the middle shows the date and time (Sunday 4th October 02:35)
with a small faint dot on each side.

## Install

```bash
./install.sh
```

This links the repo at `~/.claude/mods/fleet-street`. If a real folder is already there, it is moved to
`~/.claude/backups/fleet-street.<timestamp>`, never deleted. The script is safe to run again.

Claude Code loads the mod through `CLAUDE_CODE_PLUGIN_DIRS`. If `~/.claude/settings.json` doesn't name the
path yet, the script prints the line to add to its `env` block:

```json
"CLAUDE_CODE_PLUGIN_DIRS": "/Users/<you>/.claude/mods/fleet-street"
```

Uninstall with `./install.sh --uninstall`, which removes the link and nothing else.

## Options

Set in the plugin's config:

| Option | Default | What it does |
| --- | --- | --- |
| `awayMinutes` | `30` | Minutes without activity before the banner asks whether to keep the session timer going |
| `mainBranch` | `main` | The branch shown in green; any other branch is shown in yellow |

## Develop

Edit `hooks/register.tsx`. Check it with:

```bash
claude plugin validate .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which is generated and not committed. Run
`/plugin-types` in Claude Code to write it before type-checking in an editor.

The banner is drawn on terminal and desktop surfaces. The desktop surface uses proportional text, so don't
size anything from the column count; keep decorations to fixed, single-character pieces.

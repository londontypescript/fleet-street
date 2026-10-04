# fleet-street

Usage and Status Banner Plugin for Claude

**With subagents or background tasks running:** the middle of row 2 lists them.

![The banner with a subagent and a background task running](docs/banner-busy.png)

**With no subagents or background tasks running:** the middle of row 2 shows the date and time instead, so
the row never looks empty.

![The banner with nothing running, showing the date and time](docs/banner-idle.png)

## What it shows

- **Row 1: usage**, left to right
  - `5h`: 5-hour usage as a bar and a percentage, with the time until it resets
  - `week`: weekly usage, the same way
  - `ctx`: context used out of the window, as tokens and a percentage
  - `cache`: the prompt-cache countdown, yellow in the last five minutes and red in the last minute
- **Row 2: status**, left to right
  - Left: the git branch, green on the main branch and yellow on any other
  - Middle, while subagents are running: `agents`, each with its model, tokens used and how long it has run
  - Middle, while background tasks are running: `bg`, each with how long it has run
  - Middle, when neither is running: the date and time
  - Right: `time`, how long the session has been running
- **Row 3: recent sessions**: this project's three most recently active other sessions in the desktop app,
  each in its own box with its title and how long ago it was last active. Clicking a title opens that session.
  `/toggle-sessions` hides or shows the row. The sessions are read from the desktop app's data folder
  (`%APPDATA%\Claude` on Windows, `~/Library/Application Support/Claude` on macOS, `~/.config/Claude` on
  Linux); on a machine without the desktop app the row is not drawn.

Bars and percentages go green, yellow, then red as usage rises. After a long gap, a prompt asks whether to
keep the session timer going.

## Install

```bash
./install.sh
```

It needs `jq`. The script does two things, then asks you to start a new Claude Code session:

- Links the repo at `~/.claude/mods/fleet-street`. If a real folder is already there, it is moved to
  `~/.claude/backups/fleet-street.<timestamp>`, never deleted.
- Adds that path to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, which is how Claude Code
  loads the mod. Any paths already listed there stay, separated by `:`. The file is backed up to
  `~/.claude/backups/settings.json.<timestamp>` first.

It is safe to run again. `./install.sh --uninstall` removes the link and this one path from settings,
and nothing else.

## Options

Set in the plugin's config:

| Option | Default | What it does |
| --- | --- | --- |
| `awayMinutes` | `30` | Minutes without activity before the banner asks whether to keep the session timer going |
| `mainBranch` | `main` | The branch shown in green; any other branch is shown in yellow |
| `showSessions` | `true` | Show the row of this project's recent sessions |

## Commands

- `/reset-timer` restarts the session timer.
- `/toggle-sessions` hides or shows the recent-sessions row for the current session, whatever
  `showSessions` says.

## Develop

Edit `hooks/register.tsx`. Check it with:

```bash
claude plugin validate .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which is generated and not committed. Run
`/plugin-types` in Claude Code to write it before type-checking in an editor.

The banner is drawn on terminal and desktop surfaces. The desktop surface uses proportional text, so don't
size anything from the column count; keep decorations to fixed, single-character pieces.

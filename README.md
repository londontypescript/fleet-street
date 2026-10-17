# fleet-street

Usage and Status Banner Plugin for Claude

**With the recent-sessions row:** the banner with another worktree and a background task running.

![The banner with a worktree, a background task and the recent-sessions row](docs/banner.png)

**Without it:** `/toggle-sessions` hides or shows the row for the session.

![The banner with the recent-sessions row hidden](docs/banner-no-sessions.png)

## What it shows

- **Row 1: usage**, left to right
  - `5h`: 5-hour usage as a bar and a percentage, with the time until it resets
  - `week`: weekly usage, the same way
  - `ctx`: context used out of the window, as tokens and a percentage
  - `cache`: the prompt-cache countdown, yellow in the last five minutes and red in the last minute
- **Row 2: status**, left to right
  - Left: the git branch, green on the main branch and yellow on any other
  - Middle: `wt`, the repository's other worktrees, each by its branch (by its folder when detached), cut to 24
    characters, or a dimmed `none`. The worktree this session is in is left out, as its branch is on the
    left. Outside a git repository `wt` is not shown
  - Middle: `bg`, the background tasks, each with how long it has run, or a dimmed `none`
  - When the middle runs out of room it is squeezed one step at a time, stopping at the first that fits:
    subagent worktrees shortened to `agent-<hash>`, then background tasks shown as a count, then subagent
    worktrees grouped as `agent ×N`, then names cut to 12 characters, then the first names and `+N` for the
    rest, then `×N` alone. On a row too narrow even for that, the middle is left empty
  - Right: `time`, how long the session has been running
- **Row 3: PRs and diff**, left and right
  - Left: `pr`, the open pull requests whose branch is this session's branch or one of the worktrees' on row 2
    (this session's first; at most 10 branches are looked up). Each shows its number, its title and its checks
    as passed out of the total: `● 2/4` yellow while any are running, `✗ 3/4` red as soon as one fails, `✓ 4/4`
    green when all pass (skipped and neutral checks count as passed). A draft is dimmed. Clicking a PR opens it.
    PRs from forks are left out. It checks GitHub every 15 seconds while any checks are running, every 60
    seconds otherwise, and at once when the branch or the worktrees change. It needs `gh`, signed in, and an
    `origin` remote on github.com; without the remote `pr` isn't shown, and when `gh` can't answer it reads
    `pr unavailable`. If a refresh fails after one has worked (offline, say), the last list stays, dimmed
  - Right: `diff`, the lines added and deleted since the branch left the expected branch (`mainBranch`),
    uncommitted work and new files included (the lines of the first 200 new files), as `+152 −32`, or `clean`. It compares with the merge-base of
    `HEAD` and `origin/<mainBranch>` (the local `<mainBranch>` when there's no such remote branch), as the refs
    stand locally: nothing is fetched
  - When the row runs out of room, PR titles are cut to 32 characters, then 16, then left out, then the PRs
    become a count with the worst mark (`×3 ✗`). On a row too narrow even for that, the row is left empty
- **Row 4: recent sessions**, off unless turned on: the three most recently active other sessions in the
  desktop app, from any project, each in its own box with its title and how long ago it was last active.
  Clicking a title opens that session. `/toggle-sessions` shows or hides the row for the session, and
  `showSessions` turns it on for good. While it's hidden nothing is scanned. The sessions are read from the
  desktop app's data folder (`%APPDATA%\Claude` on Windows, `~/Library/Application Support/Claude` on macOS,
  `~/.config/Claude` on Linux); on a machine without the desktop app the row is not drawn.

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
| `showWork` | `true` | Show the row of open PRs and the branch's diff |
| `showSessions` | `false` | Show the row of recent sessions |

## Commands

- `/reset-timer` restarts the session timer.
- `/toggle-sessions` shows or hides the recent-sessions row for the current session, whatever
  `showSessions` says.

## Develop

Edit `hooks/register.tsx`. Check it with:

```bash
claude plugin validate .
```

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`, which is generated and not committed. Run
`/plugin-types` in Claude Code to write it before type-checking in an editor.

The banner is drawn on terminal and desktop surfaces. The desktop surface uses proportional text, so a line's
character count only estimates its width there (row 2 counts it at 85%); keep decorations to fixed,
single-character pieces.

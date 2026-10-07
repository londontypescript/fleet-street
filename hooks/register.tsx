import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Away, BgTask, Context, Limit, RecentSession, Worktree } from '../types'

const limits = atom({ plugin: 'fleet-street', key: 'limits' } as const, [] as Limit[])
const context = atom({ plugin: 'fleet-street', key: 'context' } as const, null as Context | null)
const lastResponseAt = atom({ plugin: 'fleet-street', key: 'lastResponseAt' } as const, null as number | null)
const now = atom({ plugin: 'fleet-street', key: 'now' } as const, 0)
const timerStart = atom({ plugin: 'fleet-street', key: 'timerStart' } as const, null as number | null)
const away = atom({ plugin: 'fleet-street', key: 'away' } as const, null as Away | null)
// The repository's other worktrees (not the one this session is in), in git's order.
const worktrees = atom({ plugin: 'fleet-street', key: 'worktrees' } as const, [] as Worktree[])
// Background shells and monitors (background subagents are left out).
const bgTasks = atom({ plugin: 'fleet-street', key: 'bgTasks' } as const, [] as BgTask[])
// The session folder's branch, `@<hash>` on a detached HEAD, null outside a git repository.
const branch = atom({ plugin: 'fleet-street', key: 'branch' } as const, null as string | null)

// The three most recently updated other sessions, across every project, newest first; null until a scan
// finds the desktop app's session records (never, on a machine without the desktop app).
const recent = atom({ plugin: 'fleet-street', key: 'recent' } as const, null as RecentSession[] | null)
// This session's choice from /toggle-sessions; null follows the showSessions option.
const sessionsShown = atom({ plugin: 'fleet-street', key: 'sessionsShown' } as const, null as boolean | null)

// The session timer's start lives in the store too, keyed by session, so a resume carries on counting.
const timerKey = async ($: EngineInterface) => `timer:${await $.session.id()}`
// When the person last did something (sent a prompt) or the main loop last finished; the away check measures from it.
const activeKey = async ($: EngineInterface) => `active:${await $.session.id()}`

// Prompts that mean the person is at the keyboard (typed here or through Remote Control).
const PERSON_ORIGINS = new Set(['composer', 'bridge'])


// Subscriptions (which report rate limits) get the 1-hour prompt cache; API keys the 5-minute one.
const TTL_SUBSCRIPTION_MS = 60 * 60 * 1000
const TTL_API_MS = 5 * 60 * 1000

const fmtTokens = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

// Time until a limit resets, to the minute and rounded up: 33m, 3h46m, 6d16h. Never seconds, as the
// banner redraws these once a minute.
const fmtReset = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(total / 1440)
  const h = Math.floor((total % 1440) / 60)
  const m = total % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m`
}

// Whole minutes, as 47m or 2h05m.
const fmtElapsed = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

const levelColor = (pct: number) => (pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green')

// Both halves use the same full block so they line up; the empty part is just drawn grey.
const BAR_WIDTH = 6
const filledCells = (pct: number) => Math.min(BAR_WIDTH, Math.round((pct / 100) * BAR_WIDTH))

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }

const FINAL_COUNTDOWN_MS = 5 * 60 * 1000

// m:ss in the final five minutes, whole minutes before that.
const fmtCacheLeft = (ms: number) =>
  ms <= FINAL_COUNTDOWN_MS ? fmtDuration(ms) : `${Math.min(60, Math.ceil(ms / 60_000))}m`

// Module mirrors: the away check and the task bookkeeping read them without a state round trip.
let lastActive: number | null = null

let bgCount = 0

// `cd repo && npm run dev -- --port 3000` → `npm run dev -- --port…`
const shortCommand = (command: string) => {
  const last = command.split(/\s*&&\s*/).filter(part => !/^cd\s/.test(part.trim())).pop() ?? command
  const flat = last.replace(/\s+/g, ' ').trim()
  return flat.length > 22 ? `${flat.slice(0, 21)}…` : flat
}

async function setBgTasks($: EngineInterface, fn: (list: BgTask[]) => BgTask[]) {
  await update($, bgTasks, list => {
    const next = fn(list)
    bgCount = next.length
    return next
  })
}

// A task-notification names its task as <task-id>…</task-id>.
async function endTasksIn($: EngineInterface, text: string) {
  if (bgCount === 0 || !text.includes('<task-notification')) return
  const ids = new Set([...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(m => m[1].trim()))
  if (ids.size > 0) await setBgTasks($, list => list.filter(b => !ids.has(b.id)))
}

const RECENT_COUNT = 3
// 4m, 3h, 2d: at most three characters, so the row's title budget stays predictable.
const fmtAgo = (ms: number) => {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h` : `${Math.min(99, Math.floor(h / 24))}d`
}

const truncate = (text: string, max: number) =>
  max <= 0 ? '' : text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`

// One entry in the middle of row 2: a worktree, a task, or a count standing for several.
type MidItem = { key: string; text: string; color: string; note?: string }

// `wt a │ b │ bg none`: each label and entry, a column between the parts and three around each │. An empty
// section reads `none`; a hidden one (null) takes no room.
const sectionWidth = (label: string, items: MidItem[] | null) =>
  items === null
    ? 0
    : items.length === 0
      ? label.length + 5
      : label.length + items.reduce((w, x) => w + 1 + x.text.length + (x.note ? x.note.length + 1 : 0), 0) + 3 * (items.length - 1)
const middleWidth = (wt: MidItem[] | null, bg: MidItem[]) => {
  const a = sectionWidth('wt', wt)
  return a + sectionWidth('bg', bg) + (a > 0 ? 3 : 0)
}

// A desktop draws proportional text, which takes about this share of the cells its length suggests.
const DESKTOP_TEXT_SCALE = 0.85

// The app names a subagent's worktree branch worktree-agent-<id>; the first seven of the id tell them apart.
const AGENT_BRANCH = /^worktree-agent-([0-9a-f]{7})[0-9a-f]*$/
const agentName = (name: string) => {
  const m = AGENT_BRANCH.exec(name)
  return m ? `agent-${m[1]}` : name
}

// Each recent session's cell takes the same share of the row; the gaps between them take the rest.
const CELL_PERCENT = 32
// A cell's frame: a rounded border and a column of padding on each side.
const CELL_FRAME = 4

// What one desktop session record says, kept until the file changes.
type SessionRecord = {
  id: string
  cliId?: string
  title: string
  updatedAt: number
  archived: boolean
}
const records = new Map<string, { mtimeMs: number; record: SessionRecord | null }>()
const realPaths = new Map<string, string | null>()

const realPath = async ($: EngineInterface, path: string) => {
  if (!realPaths.has(path)) {
    const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
    realPaths.set(path, stat?.realPath ?? null)
  }
  return realPaths.get(path) ?? null
}

const parseRecord = (text: string): SessionRecord | null => {
  try {
    const s = JSON.parse(text)
    const at = s.lastActivityAt ?? s.createdAt
    if (typeof s.sessionId !== 'string' || !at) return null
    return {
      id: s.sessionId,
      cliId: typeof s.cliSessionId === 'string' ? s.cliSessionId : undefined,
      title: String(s.title || 'Untitled').split(/\s+/).filter(Boolean).join(' '),
      updatedAt: Number(at),
      archived: Boolean(s.isArchived),
    }
  } catch {
    return null
  }
}

type DesktopOs = 'windows' | 'macos' | 'linux'
type SessionsRoot = { os: DesktopOs; path: string }

// Where the desktop app keeps its session records: its Electron data folder, which each OS places
// differently, then claude-code-sessions. The plugin API names no OS, so each candidate is tried in
// turn; null when none exists (no desktop app on this machine).
async function findSessionsRoot($: EngineInterface): Promise<SessionsRoot | null> {
  const appData = await $.env.get('APPDATA')
  const home = await $.env.get('HOME')
  const xdg = await $.env.get('XDG_CONFIG_HOME')
  const candidates: SessionsRoot[] = []
  if (appData) candidates.push({ os: 'windows', path: `${appData}/Claude` })
  if (home) candidates.push({ os: 'macos', path: `${home}/Library/Application Support/Claude` })
  if (xdg || home) candidates.push({ os: 'linux', path: `${xdg || `${home}/.config`}/Claude` })
  for (const c of candidates) {
    const path = `${c.path}/claude-code-sessions`
    if (await $.fs.exists(path)) return { os: c.os, path }
  }
  return null
}

let sessionsRoot: SessionsRoot | null | undefined

// The desktop app's own session records (<root>/<account>/<org>/local_*.json), scanned for the latest
// unarchived sessions other than this one, whatever their folder. Only files changed since the last scan
// are read again. With no desktop app the list is null and the row is not drawn.
async function refreshRecent($: EngineInterface) {
  if (sessionsRoot === undefined || sessionsRoot === null) sessionsRoot = await findSessionsRoot($)
  if (sessionsRoot === null) {
    if ((await read($, recent)) !== null) await update($, recent, () => null)
    return
  }
  const { path: root } = sessionsRoot
  const current = await $.session.id()
  const dirsOf = async (path: string) =>
    (await $.fs.list(path).catch(() => [])).filter(d => d.kind === 'dir').map(d => `${path}/${d.name}`)

  const found: RecentSession[] = []
  const seen = new Set<string>()
  for (const account of await dirsOf(root)) {
    for (const org of await dirsOf(account)) {
      for (const f of await $.fs.list(org).catch(() => [])) {
        if (f.kind !== 'file' || !/^local_.*\.json$/.test(f.name)) continue
        const path = `${org}/${f.name}`
        seen.add(path)
        let cached = records.get(path)
        if (!cached || cached.mtimeMs !== f.mtimeMs) {
          const text = await $.fs.read(path).catch(() => null)
          cached = { mtimeMs: f.mtimeMs, record: text === null ? null : parseRecord(text) }
          records.set(path, cached)
        }
        const r = cached.record
        if (!r || r.archived || (r.cliId !== undefined && r.cliId === current)) continue
        found.push({ id: r.id, title: r.title, updatedAt: r.updatedAt, link: `claude://claude.ai/epitaxy/${r.id}` })
      }
    }
  }
  for (const path of records.keys()) if (!seen.has(path)) records.delete(path)

  const next = found.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, RECENT_COUNT)
  const key = (list: RecentSession[] | null) => (list ?? []).map(r => `${r.id}|${r.title}|${r.updatedAt}`).join()
  const shown = await read($, recent)
  if (shown === null || key(next) !== key(shown)) await update($, recent, () => next)
}

// Sessions open through the desktop app's deep link, handed to the OS's own opener.
const OPENERS: Record<DesktopOs, (link: string) => string[]> = {
  macos: link => ['open', link],
  // Not `cmd /c start`, whose quoting of an empty title argument does not survive being passed as an argv.
  windows: link => ['rundll32', 'url.dll,FileProtocolHandler', link],
  linux: link => ['xdg-open', link],
}

const openSession = async ($: EngineInterface, link: string) => {
  if (!sessionsRoot) return
  const ran = await $.process.run(OPENERS[sessionsRoot.os](link)).catch(err => ({ exitCode: 1, stderr: String(err) }))
  if (ran.exitCode !== 0) $.ui.toast(`Could not open session: ${ran.stderr.slice(0, 80)}`)
}

let branchShown: string | null | undefined

async function refreshBranch($: EngineInterface) {
  const cwd = await $.session.cwd()
  const git = (...args: string[]) => $.process.run(['git', ...args], { cwd, timeoutMs: 5000 })
  let name: string | null = null
  const current = await git('branch', '--show-current').catch(() => null)
  if (current && current.exitCode === 0) {
    name = current.stdout.trim()
    if (name === '') {
      const head = await git('rev-parse', '--short', 'HEAD').catch(() => null)
      name = head && head.exitCode === 0 ? `@${head.stdout.trim()}` : null
    }
  }
  if (name !== branchShown) {
    branchShown = name
    await update($, branch, () => name)
  }
}

let worktreesShown = ''

// `git worktree list --porcelain`: one block per worktree, `worktree <path>` then `branch refs/heads/<name>`
// or `detached`. The session's own worktree and stale (prunable) ones are left out.
async function refreshWorktrees($: EngineInterface) {
  const cwd = await $.session.cwd()
  const git = (...args: string[]) => $.process.run(['git', ...args], { cwd, timeoutMs: 5000 })
  const top = await git('rev-parse', '--show-toplevel').catch(() => null)
  const listed = top && top.exitCode === 0 ? await git('worktree', 'list', '--porcelain').catch(() => null) : null
  const found: Worktree[] = []
  if (top && listed && listed.exitCode === 0) {
    const here = await realPath($, top.stdout.trim())
    for (const block of listed.stdout.split(/\n\s*\n/)) {
      const lines = block.split('\n').map(l => l.trim())
      const path = lines.find(l => l.startsWith('worktree '))?.slice(9)
      if (!path || lines.some(l => l === 'bare' || l.startsWith('prunable'))) continue
      if ((await realPath($, path)) === here) continue
      const ref = lines.find(l => l.startsWith('branch '))?.slice(7)
      const head = lines.find(l => l.startsWith('HEAD '))?.slice(5, 12)
      const name = ref ? ref.replace(/^refs\/heads\//, '') : head ? `@${head}` : path.split('/').pop() ?? path
      found.push({ path, name, agent: /\/\.claude\/worktrees\/agent-[^/]+$/.test(path) || AGENT_BRANCH.test(name) })
    }
  }
  const key = found.map(w => `${w.path}|${w.name}`).join()
  if (key !== worktreesShown) {
    worktreesShown = key
    await update($, worktrees, () => found)
  }
}

async function setTimer($: EngineInterface, start: number) {
  await $.store.set(await timerKey($), start)
  await update($, timerStart, () => start)
  await update($, away, () => null)
  await update($, now, () => Date.now())
}

async function markActive($: EngineInterface, t: number) {
  lastActive = t
  await $.store.set(await activeKey($), t)
}

export const register: Register = (on, options) => {
  const awayMs = Number(options.awayMinutes ?? 30) * 60_000
  const mainBranch = String(options.mainBranch ?? 'main')
  const showSessions = options.showSessions !== false
  // Mirrors of state the timer needs, so it can decide whether a redraw would change anything.
  let lastAt: number | null = null
  let ttl = TTL_API_MS
  let drawnKey = ''

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const usage = await $.session.usage()
    ttl = usage.rateLimits.length > 0 ? TTL_SUBSCRIPTION_MS : TTL_API_MS
    lastAt = await read($, lastResponseAt)
    await update($, limits, () => usage.rateLimits)
    await update($, context, () => usage.context)
    await update($, now, () => Date.now())
    const key = await timerKey($)
    const saved = await $.store.get(key)
    const start = typeof saved === 'number' ? saved : Date.now()
    if (saved !== start) await $.store.set(key, start)
    await update($, timerStart, () => start)
    const active = await $.store.get(await activeKey($))
    lastActive = typeof active === 'number' ? active : null
    bgCount = (await read($, bgTasks)).length
    await $.command.register({ name: 'reset-timer', description: 'Restart the session timer in the fleet-street banner' })
    await $.command.register({
      name: 'toggle-sessions',
      description: 'Hide or show the recent-sessions row in the fleet-street banner for this session',
    })
    void refreshBranch($)
    void refreshWorktrees($)
    void refreshRecent($).catch(err => $.ui.log(`fleet-street: recent sessions failed: ${err}`))
    $.clock.every(1000, () => {
      const t = Date.now()
      // A checkout made outside the session (another terminal) shows within five seconds.
      if (Math.floor(t / 1000) % 5 === 0) {
        void refreshBranch($)
        void refreshWorktrees($)
      }
      if (Math.floor(t / 1000) % 15 === 0) void refreshRecent($).catch(() => {})
      const left = lastAt === null ? Infinity : lastAt + ttl - t
      const key = left > 0 && left <= FINAL_COUNTDOWN_MS ? `s${Math.floor(t / 1000)}` : `m${Math.floor(t / 60_000)}:${left > 0}`
      if (key !== drawnKey) {
        drawnKey = key
        void update($, now, () => t)
      }
    })
    return result
  })

  on('command.run', { command: 'reset-timer' }, async $ => {
    await setTimer($, Date.now())
    return { text: 'Session timer restarted.' }
  })

  on('command.run', { command: 'toggle-sessions' }, async $ => {
    const shown = !((await read($, sessionsShown)) ?? showSessions)
    await update($, sessionsShown, () => shown)
    return { text: shown ? 'Recent sessions shown.' : 'Recent sessions hidden.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (PERSON_ORIGINS.has(e.origin.kind)) {
      const t = Date.now()
      const started = await read($, timerStart)
      if (started !== null && lastActive !== null && t - lastActive >= awayMs) {
        const gapMs = t - lastActive
        await update($, away, () => ({ gapMs }))
      }
      await markActive($, t)
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const startedAt = Date.now()
    const result = await next(e)
    // Started in the background, or pushed there with Ctrl+B while it ran.
    const id = result.result && !result.isError ? result.result.backgroundTaskId : undefined
    if (id) {
      const task: BgTask = { id, label: shortCommand(e.command), startedAt }
      await setBgTasks($, list => [...list.filter(b => b.id !== id), task])
    }
    return result
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const result = await next(e)
    const id = result.result && !result.isError ? result.result.taskId : undefined
    if (id) {
      const task: BgTask = { id, label: `monitor ${e.description}`.slice(0, 22), startedAt: Date.now() }
      await setBgTasks($, list => [...list.filter(b => b.id !== id), task])
    }
    return result
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const result = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id && bgCount > 0) await setBgTasks($, list => list.filter(b => b.id !== id))
    return result
  })

  // A finished task reports back as a notification row, in a turn of its own or folded into a running one.
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (bgCount > 0 && e.message.type === 'user') {
      for (const block of e.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') await endTasksIn($, block.text)
      }
    }
    return result
  })

  // The safety net: each main turn's end lists the work still in flight.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    const inFlight = e.background_tasks
    if (inFlight) {
      const live = inFlight.filter(b => b.type !== 'subagent')
      await setBgTasks($, list => {
        const kept = list.filter(b => live.some(l => l.id === b.id))
        const seen = new Set(kept.map(b => b.id))
        const found = live
          .filter(l => !seen.has(l.id))
          .map(l => ({ id: l.id, label: shortCommand(l.command ?? l.description), startedAt: Date.now() }))
        return found.length === 0 && kept.length === list.length ? list : [...kept, ...found]
      })
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    ttl = e.rateLimits.length > 0 ? TTL_SUBSCRIPTION_MS : TTL_API_MS
    await update($, limits, () => e.rateLimits)
    await update($, context, () => e.context)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) {
      const at = Date.now()
      lastAt = at
      await update($, lastResponseAt, () => at)
      await update($, now, () => at)
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const at = Date.now()
      lastAt = at
      await update($, lastResponseAt, () => at)
      await update($, now, () => at)
      await markActive($, at)
      await refreshBranch($)
      await refreshWorktrees($)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const t = await read($, now)
    const ls = await read($, limits)
    const ctx = await read($, context)
    const last = await read($, lastResponseAt)
    const started = await read($, timerStart)
    const gap = await read($, away)
    const trees = await read($, worktrees)
    const onBranch = await read($, branch)
    const bg = await read($, bgTasks)
    const sessions = await read($, recent)
    const sessionsOn = (await read($, sessionsShown)) ?? showSessions

    // Spacing comes from Box gaps, not spaces inside Text: the desktop surface trims those.
    const sep = <Text dimColor>│</Text>
    const parts: RenderChildren[] = []

    for (const l of ls) {
      const reset = l.resetsAt ? fmtReset(Date.parse(l.resetsAt) - t) : null
      const filled = filledCells(l.percentUsed)
      parts.push(
        <Box columnGap={1}>
          <Text bold>{LABELS[l.kind] ?? l.kind}</Text>
          <Box>
            <Text color={levelColor(l.percentUsed)}>{'█'.repeat(filled)}</Text>
            <Text color="gray">{'█'.repeat(BAR_WIDTH - filled)}</Text>
          </Box>
          <Text color={levelColor(l.percentUsed)}>{Math.round(l.percentUsed)}%</Text>
          {reset ? <Text dimColor>{reset}</Text> : null}
        </Box>,
      )
    }
    if (ls.length === 0) {
      parts.push(<Text dimColor>limits: waiting for first reply</Text>)
    }

    if (ctx) {
      const pct = ctx.percent ?? 0
      parts.push(
        <Box columnGap={1}>
          <Text bold>ctx</Text>
          <Text color={levelColor(pct)}>
            {fmtTokens(ctx.tokens ?? 0)}/{fmtTokens(ctx.window)}
          </Text>
          <Text color={levelColor(pct)}>{pct}%</Text>
        </Box>,
      )
    }

    const cache = (color: string | undefined, dot: string, label: string) => (
      <Box columnGap={1}>
        <Text bold>cache</Text>
        <Text color={color} dimColor={color === undefined}>
          {dot}
        </Text>
        <Text color={color} dimColor={color === undefined}>
          {label}
        </Text>
      </Box>
    )
    if (last === null) {
      parts.push(cache(undefined, '○', 'cold'))
    } else if (e.props.isWorking) {
      parts.push(cache('green', '●', 'live'))
    } else {
      const left = last + ttl - t
      parts.push(
        left > 0
          ? cache(left < 60_000 ? 'red' : left <= FINAL_COUNTDOWN_MS ? 'yellow' : 'green', '●', fmtCacheLeft(left))
          : cache('red', '○', 'expired'),
      )
    }

    const firstLine = (
      <Box width="100%" flexWrap="nowrap" justifyContent="space-between" columnGap={1}>
        {parts.flatMap((p, i) => (i === 0 ? [p] : [sep, p]))}
      </Box>
    )

    const awayLine =
      gap && started !== null ? (
        <Box columnGap={1}>
          <Text color="yellow">Away {fmtElapsed(gap.gapMs)}: keep the timer going?</Text>
          <Button key="continue" label="Continue" hotkey="c" variant="primary" onPress={() => update($, away, () => null)} />
          <Button
            key="skip"
            label="Skip the gap"
            hotkey="s"
            onPress={() => setTimer($, Math.min(Date.now(), started + gap.gapMs))}
          />
          <Button key="restart" label="Restart" hotkey="r" onPress={() => setTimer($, Date.now())} />
        </Box>
      ) : null

    // Under a minute reads <1m, so the banner keeps its once-a-minute redraw.
    const age = (startedAt: number) => (t - startedAt < 60_000 ? '<1m' : fmtElapsed(t - startedAt))
    // The second line's outer columns share one width, so the middle one sits at the true centre.
    const elapsed = started !== null ? fmtElapsed(t - started) : null
    const sideWidth = Math.max(onBranch ? onBranch.length + 3 : 0, elapsed ? elapsed.length + 5 : 0)
    // The middle's room in character cells; a desktop's proportional text takes fewer than its length.
    const room = e.props.bodyColumns - 2 * sideWidth - 2
    const scale = e.surface === 'terminal' ? 1 : DESKTOP_TEXT_SCALE

    const branchPart = onBranch ? (
      <Text color={onBranch === mainBranch ? 'green' : 'yellow'} bold={onBranch !== mainBranch}>
        ⎇ {onBranch}
      </Text>
    ) : null

    // Worktrees and background tasks, squeezed one step at a time until they fit on the line: the full list;
    // subagent worktrees by their hash; tasks as a count; subagent worktrees as a count; names cut to 12;
    // the first names and a count of the rest; and last a count alone.
    const own = trees.filter(w => !w.agent)
    const byAgents = trees.filter(w => w.agent)
    const wtItems = (shorten: boolean, group: boolean, max: number): MidItem[] => {
      const named = (w: Worktree): MidItem => ({
        key: w.path,
        text: truncate(shorten && w.agent ? agentName(w.name) : w.name, max),
        color: w.name === mainBranch ? 'green' : 'cyan',
      })
      return group && byAgents.length > 1
        ? [...own.map(named), { key: 'agents', text: `agent ×${byAgents.length}`, color: 'cyan' }]
        : [...own, ...byAgents].map(named)
    }
    const bgFull: MidItem[] = bg.map(b => ({ key: b.id, text: b.label, color: 'magenta', note: age(b.startedAt) }))
    const bgCount: MidItem[] =
      bg.length === 0 ? [] : [{ key: 'bg', text: `×${bg.length}`, color: 'magenta', note: age(Math.min(...bg.map(b => b.startedAt))) }]
    const tight = wtItems(true, true, 12)
    const layouts: [MidItem[], MidItem[]][] = [
      [wtItems(false, false, 24), bgFull],
      [wtItems(true, false, 24), bgFull],
      [wtItems(true, false, 24), bgCount],
      [wtItems(true, true, 24), bgCount],
      [tight, bgCount],
    ]
    for (let k = tight.length - 1; k >= 1; k--) {
      layouts.push([[...tight.slice(0, k), { key: 'more', text: `+${tight.length - k}`, color: 'cyan' }], bgCount])
    }
    if (trees.length > 0) layouts.push([[{ key: 'count', text: `×${trees.length}`, color: 'cyan' }], bgCount])
    // Outside a git repository there are no worktrees to speak of, so `wt` is left out rather than shown as none.
    const inRepo = onBranch !== null
    const [wtShown, bgShown] =
      layouts.find(([w, b]) => middleWidth(inRepo ? w : null, b) * scale <= room) ?? layouts[layouts.length - 1] ?? [[], []]

    const section = (label: string, items: MidItem[]) => (
      <Box flexWrap="nowrap" columnGap={1}>
        <Text bold>{label}</Text>
        {items.length === 0 ? (
          <Text dimColor>none</Text>
        ) : (
          items.flatMap((x, i) => {
            const row = (
              <Box key={x.key} columnGap={1}>
                <Text color={x.color}>{x.text}</Text>
                {x.note ? <Text dimColor>{x.note}</Text> : null}
              </Box>
            )
            return i === 0 ? [row] : [sep, row]
          })
        )}
      </Box>
    )

    const timePart = elapsed ? (
      <Box columnGap={1}>
        <Text bold>time</Text>
        <Text>{elapsed}</Text>
      </Box>
    ) : null

    // Branch on the left, worktrees and background tasks in the middle (each `none` when empty), session
    // time on the right.
    const middleParts = inRepo ? [section('wt', wtShown), section('bg', bgShown)] : [section('bg', bgShown)]
    const statusLine =
      branchPart || timePart || middleParts.length > 0 ? (
        <Box width="100%" flexWrap="nowrap" columnGap={1}>
          <Box width={sideWidth} flexShrink={0}>
            {branchPart}
          </Box>
          {/* Spread evenly: the gaps take the spare room and shrink to one column as the lists grow. */}
          <Box flexGrow={1} justifyContent="space-evenly" columnGap={1}>
            {middleParts.flatMap((p, i) => (i === 0 ? [p] : [sep, p]))}
          </Box>
          <Box width={sideWidth} flexShrink={0} justifyContent="flex-end">
            {timePart}
          </Box>
        </Box>
      ) : null

    // Recent sessions: three equal rounded cells spread edge to edge, each with its title and age
    // together in the middle. The terminal cuts a title to the cell's columns; a desktop draws a proportional
    // font narrower than its cells, so there the cell gets the whole title and clips only true overflow.
    const cellColumns = Math.floor((e.props.bodyColumns * CELL_PERCENT) / 100)
    const recentLine = !sessionsOn || sessions === null ? null : sessions.length === 0 ? (
        <Text dimColor>recent: no sessions found</Text>
      ) : cellColumns >= 16 ? (
        <Box width="100%" flexWrap="nowrap" justifyContent="space-between">
          {sessions.map(s => {
            const ago = fmtAgo(t - s.updatedAt)
            const title = e.surface === 'terminal' ? truncate(s.title, cellColumns - CELL_FRAME - 1 - ago.length) : s.title
            return (
              <Box
                key={s.id}
                width={`${CELL_PERCENT}%`}
                flexWrap="nowrap"
                justifyContent="center"
                columnGap={1}
                borderStyle="round"
                borderDimColor
                hover={{ borderDimColor: false }}
                paddingX={1}
              >
                <Box flexShrink={1} overflow="hidden">
                  <Button key={`o:${s.id}`} label={title} plain dimColor onPress={() => openSession($, s.link)} />
                </Box>
                <Box flexShrink={0}>
                  <Text dimColor>{ago}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
      ) : null

    if (!awayLine && !statusLine && !recentLine) {
      return firstLine
    }

    return (
      <Box width="100%" flexDirection="column" rowGap={1}>
        {firstLine}
        {awayLine}
        {statusLine}
        {recentLine}
      </Box>
    )
  })
}

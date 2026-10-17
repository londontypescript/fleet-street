import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register, RenderChildren } from 'claude-code'

import type { Away, BgTask, Checks, Context, DiffState, Limit, Pr, PrState, RecentSession, Worktree } from '../types'

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
// The open PRs from this session's branch and the worktrees' branches; null when the repository isn't on GitHub.
const prs = atom({ plugin: 'fleet-street', key: 'prs' } as const, null as PrState | null)
// The branch's diff against the main branch; null outside a git repository or with the work row off.
const diff = atom({ plugin: 'fleet-street', key: 'diff' } as const, null as DiffState | null)

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

// Cut by characters, not UTF-16 units, so an emoji is never split in half.
const truncate = (text: string, max: number) => {
  const chars = Array.from(text)
  return max <= 0 ? '' : chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`
}

// One entry in the middle of row 2: a worktree, a task, or a count standing for several.
// count: how many worktrees the entry stands for, so `+N` counts the worktrees it hides.
type MidItem = { key: string; text: string; color: string; note?: string; count?: number }

// `wt a │ b │ bg none`: each label and entry with the column before it, and each │ with the one after it. An empty
// section reads `none`; a hidden one (null) takes no room.
const sectionWidth = (label: string, items: MidItem[] | null) =>
  items === null
    ? 0
    : items.length === 0
      ? label.length + 5
      : label.length + items.reduce((w, x) => w + 1 + x.text.length + (x.note ? x.note.length + 1 : 0), 0) + 2 * (items.length - 1)
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
const realPaths = new Map<string, string>()

// A path with its symlinks resolved; null when it can't be, and then asked again next time.
const realPath = async ($: EngineInterface, path: string) => {
  if (!realPaths.has(path)) {
    const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
    if (stat?.realPath) realPaths.set(path, stat.realPath)
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
// Whether the recent-sessions row is shown (this session's /toggle-sessions choice, else the option); while
// it is hidden nothing is scanned.
let sessionsVisible = false
let recentRunning = false

// The desktop app's own session records (<root>/<account>/<org>/local_*.json), scanned for the latest
// unarchived sessions other than this one, whatever their folder. Only files changed since the last scan
// are read again. With no desktop app the list is null and the row is not drawn.
async function refreshRecent($: EngineInterface) {
  if (!sessionsVisible || recentRunning) return
  recentRunning = true
  try {
    await scanRecent($)
  } finally {
    recentRunning = false
  }
}

async function scanRecent($: EngineInterface) {
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

// Set from the options when the session starts.
let mainBranchName = 'main'
let workVisible = true

const ok = (r: ProcessRunResult | null): r is ProcessRunResult => r !== null && r.exitCode === 0
type Git = (...args: string[]) => Promise<ProcessRunResult | null>

// The repository the session is in, as the last local refresh found it: its top folder, its GitHub
// repository (owner/name; null when origin isn't on github.com) and the branches whose PRs the row shows.
type RepoContext = { top: string; slug: string | null; branches: string[] }
let repoContext: RepoContext | null = null
const contextKey = (c: RepoContext | null) => (c ? [c.top, c.slug, ...c.branches].join('\0') : '')

// origin's URL in each of git's spellings: git@github.com:o/n.git, ssh://git@github.com/o/n, https://github.com/o/n.
const GITHUB_URL = /^(?:git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/
const githubSlug = (url: string) => {
  const m = GITHUB_URL.exec(url.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

let branchShown: string | null | undefined
let worktreesShown = ''
let treesKnown: Worktree[] = []
let diffShown = ''

let localRunning = false
let localAgain = false

// Branch, worktrees and diff, read in one pass from the repository's top folder so they always describe
// the same checkout. One pass runs at a time; a call while one runs asks for one more after it.
async function refreshLocal($: EngineInterface) {
  if (localRunning) {
    localAgain = true
    return
  }
  localRunning = true
  try {
    do {
      localAgain = false
      await scanLocal($)
    } while (localAgain)
  } catch (err) {
    $.ui.log(`fleet-street: git refresh failed: ${err}`)
  } finally {
    localRunning = false
  }
}

async function scanLocal($: EngineInterface) {
  const cwd = await $.session.cwd()
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 }).catch(() => null)
  if (!ok(top)) {
    await publishLocal($, null, [], null, null)
    return
  }
  // Only git's closing newline is cut: like the worktree paths, this one may end in a space.
  const topPath = top.stdout.replace(/\r?\n$/, '')
  const git: Git = (...args) => $.process.run(['git', ...args], { cwd: topPath, timeoutMs: 5000 }).catch(() => null)

  let name: string | null = null
  let onBranch: string | null = null
  const current = await git('branch', '--show-current')
  if (ok(current)) {
    onBranch = current.stdout.trim() || null
    name = onBranch
    if (name === null) {
      const head = await git('rev-parse', '--short', 'HEAD')
      name = ok(head) ? `@${head.stdout.trim()}` : null
    }
  }
  const listed = await listWorktrees($, git, topPath)
  const trees = listed ?? treesKnown
  const origin = await git('remote', 'get-url', 'origin')
  const slug = ok(origin) ? githubSlug(origin.stdout) : null
  const d = workVisible ? await readDiff(git) : null
  // This session's branch first, then the worktrees' in the order row 2 shows them; detached ones have none.
  const ordered = [onBranch, ...trees.filter(w => !w.agent).map(w => w.branch), ...trees.filter(w => w.agent).map(w => w.branch)]
  const branches = [...new Set(ordered.filter((b): b is string => b !== null))].slice(0, PR_BRANCHES)
  await publishLocal($, name, listed, d, { top: topPath, slug, branches })
}

// A failed listing (null) keeps the worktrees last shown, so a hiccup neither blanks row 2 nor sets off a PR refresh.
async function publishLocal($: EngineInterface, name: string | null, trees: Worktree[] | null, d: DiffState | null, ctx: RepoContext | null) {
  if (name !== branchShown) {
    branchShown = name
    await update($, branch, () => name)
  }
  if (trees !== null) {
    treesKnown = trees
    const key = trees.map(w => `${w.path}|${w.name}`).join()
    if (key !== worktreesShown) {
      worktreesShown = key
      await update($, worktrees, () => trees)
    }
  }
  const dk = JSON.stringify(d)
  if (dk !== diffShown) {
    diffShown = dk
    await update($, diff, () => d)
  }
  const changed = contextKey(ctx) !== contextKey(repoContext)
  repoContext = ctx
  if (changed) void refreshPrs($)
}

// `git worktree list --porcelain`: one block per worktree, `worktree <path>` then `branch refs/heads/<name>`
// or `detached` (named by its folder). The session's own worktree and stale (prunable) ones are left out.
// null when git can't list them.
async function listWorktrees($: EngineInterface, git: Git, topPath: string): Promise<Worktree[] | null> {
  const listed = await git('worktree', 'list', '--porcelain')
  if (!ok(listed)) return null
  const found: Worktree[] = []
  const here = await realPath($, topPath)
  // Lines are split but not trimmed: a path may end in a space.
  for (const block of listed.stdout.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const path = lines.find(l => l.startsWith('worktree '))?.slice(9)
    if (!path || lines.some(l => l === 'bare' || l.startsWith('prunable'))) continue
    // Only two paths that both resolve can be the same; failing that, the paths as git gives them.
    const real = await realPath($, path)
    if (here !== null && real !== null ? real === here : path === topPath) continue
    const ref = lines.find(l => l.startsWith('branch '))?.slice(7)
    // A detached worktree has no branch to go by, so its folder names it (a throwaway checkout's
    // folder says what it is for); the commit only when the folder can't be named.
    const head = lines.find(l => l.startsWith('HEAD '))?.slice(5, 12)
    const folder = path.split(/[\\/]/).filter(Boolean).pop()
    const onBranch = ref ? ref.replace(/^refs\/heads\//, '') : null
    const name = onBranch ?? folder ?? (head ? `@${head}` : path)
    found.push({ path, name, branch: onBranch, agent: /\/\.claude\/worktrees\/agent-[^/]+$/.test(path) || AGENT_BRANCH.test(name) })
  }
  return found
}

// New files' lines are counted for at most this many of them.
const UNTRACKED_COUNTED = 200

// Lines added and deleted since the branch left the main branch, uncommitted work included: the working tree
// against the merge-base of HEAD and origin/<main> (the local <main> when there's no such remote branch), as
// the refs stand locally (nothing is fetched). New files count as added lines; binaries as no lines.
async function readDiff(git: Git): Promise<DiffState> {
  const remote = `refs/remotes/origin/${mainBranchName}`
  const local = `refs/heads/${mainBranchName}`
  const base = ok(await git('rev-parse', '--verify', '--quiet', `${remote}^{commit}`))
    ? remote
    : ok(await git('rev-parse', '--verify', '--quiet', `${local}^{commit}`))
      ? local
      : null
  if (base === null) return { kind: 'unavailable' }
  const mb = await git('merge-base', 'HEAD', base)
  if (!ok(mb)) return { kind: 'unavailable' }
  const numstat = await git('diff', '--numstat', '-z', mb.stdout.trim())
  if (!ok(numstat) || numstat.isStdoutTruncated) return { kind: 'unavailable' }
  let added = 0
  let deleted = 0
  let files = 0
  // `<added>\t<deleted>\t<path>\0` per file, `-` for a binary's counts; a rename leaves the path empty and
  // follows with its old and new paths as tokens of their own.
  const tokens = numstat.stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i] ?? '')
    if (!m) continue
    files++
    if (m[1] !== '-') added += Number(m[1])
    if (m[2] !== '-') deleted += Number(m[2])
    if (m[3] === '') i += 2
  }
  const others = await git('ls-files', '--others', '--exclude-standard', '-z')
  const untracked = ok(others) ? others.stdout.split('\0').filter(Boolean) : []
  if (untracked.length > 0) {
    // `<path>\0<lines>` per text file with any lines; binaries (-I) and empty files are left out, and git
    // exits 1 when that leaves nothing.
    const counted = await git('--literal-pathspecs', 'grep', '--untracked', '--no-color', '-I', '-c', '-z', '', '--', ...untracked.slice(0, UNTRACKED_COUNTED))
    if (counted && counted.exitCode === 0) {
      for (const line of counted.stdout.split('\n')) {
        const n = Number(line.split('\0')[1])
        if (Number.isFinite(n)) added += n
      }
    }
  }
  return { kind: 'ok', added, deleted, clean: files === 0 && untracked.length === 0 }
}

// PRs are looked up for at most this many branches: this session's, then the worktrees'.
const PR_BRANCHES = 10
const PR_FIELDS = 'number,title,url,headRefName,isDraft,isCrossRepository,statusCheckRollup'
// While any shown PR has checks running, then once they've all finished, and after a rate-limit reply.
const PR_FAST_MS = 15_000
const PR_SLOW_MS = 60_000
const PR_BACKOFF_MS = 5 * 60_000
// A main turn's end refreshes the PRs at most this often.
const PR_TURN_MS = 15_000

// A check run's conclusion, or a legacy status context's state, that counts as failed or passed.
const CHECK_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR'])
const CHECK_PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
// How each result is drawn, and which wins when a count stands for several PRs.
const CHECK_MARKS: Record<Checks['state'], { mark: string; color: string | undefined; rank: number }> = {
  fail: { mark: '✗', color: 'red', rank: 3 },
  running: { mark: '●', color: 'yellow', rank: 2 },
  unknown: { mark: '?', color: undefined, rank: 1 },
  pass: { mark: '✓', color: 'green', rank: 0 },
}

// statusCheckRollup mixes check runs (`status`, then `conclusion` once COMPLETED) with legacy status
// contexts (`state`). A failure wins over running checks; a value not known here makes the result unknown.
const summariseChecks = (rollup: unknown): Checks | null => {
  if (!Array.isArray(rollup) || rollup.length === 0) return null
  let passed = 0
  let failed = 0
  let running = 0
  let unknown = 0
  for (const c of rollup as Record<string, unknown>[]) {
    const legacy = c.__typename === 'StatusContext' || (c.status === undefined && typeof c.state === 'string')
    const done = legacy ? c.state !== 'PENDING' && c.state !== 'EXPECTED' : c.status === 'COMPLETED'
    const result = String((legacy ? c.state : c.conclusion) ?? '')
    if (!done && (legacy || typeof c.status === 'string')) running++
    else if (CHECK_PASSED.has(result)) passed++
    else if (CHECK_FAILED.has(result)) failed++
    else unknown++
  }
  const state = failed > 0 ? 'fail' : running > 0 ? 'running' : unknown > 0 ? 'unknown' : 'pass'
  return { passed, total: rollup.length, state }
}

// Runs fn over the items, at most limit at once, keeping their order.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

let prsRunning = false
let prsAgain = false
let prsStartedAt = 0
// When the clock next refreshes the PRs.
let prsDueAt = 0
// The repository (top folder and slug) the shown PRs belong to, and the reason last logged.
let prsFor = ''
let prsLogged = ''
let prsShown = ''

async function refreshPrs($: EngineInterface) {
  if (prsRunning) {
    prsAgain = true
    return
  }
  prsRunning = true
  try {
    do {
      prsAgain = false
      prsStartedAt = Date.now()
      await scanPrs($)
    } while (prsAgain)
  } catch (err) {
    $.ui.log(`fleet-street: PR refresh failed: ${err}`)
    prsDueAt = Date.now() + PR_SLOW_MS
  } finally {
    prsRunning = false
  }
}

async function setPrs($: EngineInterface, next: PrState | null) {
  const key = JSON.stringify(next)
  if (key !== prsShown) {
    prsShown = key
    await update($, prs, () => next)
  }
}

type PrFail = { kind: 'unavailable' | 'stale' | 'rate'; reason: string }

const classifyGh = (slug: string, ran: { run: ProcessRunResult } | { error: string }): PrFail | null => {
  if ('error' in ran) {
    return /tim(e|ed) ?out/i.test(ran.error) ? { kind: 'stale', reason: 'gh timed out' } : { kind: 'unavailable', reason: 'gh could not run' }
  }
  if (ran.run.exitCode === 0) return null
  const err = ran.run.stderr
  if (/rate limit/i.test(err)) return { kind: 'rate', reason: 'GitHub rate limit' }
  if (/auth login|not logged in|authenticat|HTTP 401|GH_TOKEN/i.test(err)) return { kind: 'unavailable', reason: 'gh not signed in' }
  if (/Could not resolve to a Repository|HTTP 403|HTTP 404/i.test(err)) return { kind: 'unavailable', reason: `no access to ${slug}` }
  return { kind: 'stale', reason: err.trim().split(/\r?\n/)[0]?.slice(0, 80) || `gh exited ${ran.run.exitCode}` }
}

// One `gh pr list --head` per branch, so a repository with hundreds of open PRs can't push these off the first
// page. PRs from forks are dropped: a fork's branch may share a name with one here.
async function scanPrs($: EngineInterface) {
  const ctx = repoContext
  const key = contextKey(ctx)
  if (!workVisible || ctx === null || ctx.slug === null) {
    prsFor = ''
    prsDueAt = Date.now() + PR_SLOW_MS
    await setPrs($, null)
    return
  }
  const slug = ctx.slug
  const repo = `${ctx.top}\0${slug}`
  const shown = await read($, prs)
  // Only the branches changed: keep what's known for those still here until the answer lands.
  if (repo === prsFor && shown?.kind === 'ok') {
    await setPrs($, { ...shown, prs: shown.prs.filter(p => ctx.branches.includes(p.branch)) })
  } else if (repo !== prsFor) {
    prsFor = repo
    await setPrs($, { kind: 'loading' })
  }

  const answers = await mapLimit(ctx.branches, 4, b =>
    $.process
      .run(['gh', 'pr', 'list', '-R', slug, '--head', b, '--state', 'open', '--limit', '20', '--json', PR_FIELDS], {
        cwd: ctx.top,
        timeoutMs: 15_000,
        env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
      })
      .then(run => ({ run }), err => ({ error: String(err) })),
  )
  // The repository or branches changed while gh ran; the refresh that change asked for follows.
  if (contextKey(repoContext) !== key) return

  const found: Pr[] = []
  let failed: PrFail | null = null
  // An unavailable answer outranks a rate limit, which outranks a passing failure.
  const rank = { unavailable: 3, rate: 2, stale: 1 }
  for (const [i, ran] of answers.entries()) {
    const branchName = ctx.branches[i] as string
    let f = classifyGh(slug, ran)
    if (f === null && 'run' in ran) {
      try {
        const list = JSON.parse(ran.run.stdout) as Record<string, unknown>[]
        for (const p of list) {
          if (p.isCrossRepository || p.headRefName !== branchName || found.some(x => x.number === p.number)) continue
          found.push({
            number: Number(p.number),
            title: String(p.title ?? '').replace(/\s+/g, ' ').trim(),
            url: String(p.url ?? ''),
            branch: branchName,
            draft: Boolean(p.isDraft),
            checks: summariseChecks(p.statusCheckRollup),
          })
        }
      } catch {
        f = { kind: 'stale', reason: 'gh gave an unreadable reply' }
      }
    }
    if (f && (!failed || rank[f.kind] > rank[failed.kind])) failed = f
  }

  const now = Date.now()
  if (failed === null) {
    prsLogged = ''
    prsDueAt = now + (found.some(p => p.checks?.state === 'running') ? PR_FAST_MS : PR_SLOW_MS)
    await setPrs($, { kind: 'ok', prs: found, stale: false })
    return
  }
  if (failed.reason !== prsLogged) {
    prsLogged = failed.reason
    $.ui.log(`fleet-street: PRs unavailable: ${failed.reason}`)
  }
  prsDueAt = now + (failed.kind === 'rate' ? PR_BACKOFF_MS : PR_SLOW_MS)
  const current = await read($, prs)
  await setPrs(
    $,
    failed.kind !== 'unavailable' && current?.kind === 'ok'
      ? { ...current, stale: true }
      : { kind: 'unavailable', reason: failed.reason },
  )
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
  const showSessions = options.showSessions === true
  const workOn = options.showWork !== false
  workVisible = workOn
  mainBranchName = mainBranch
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
    sessionsVisible = (await read($, sessionsShown)) ?? showSessions
    void refreshLocal($)
    void refreshRecent($).catch(err => $.ui.log(`fleet-street: recent sessions failed: ${err}`))
    $.clock.every(1000, () => {
      const t = Date.now()
      // A checkout made outside the session (another terminal) shows within five seconds.
      if (Math.floor(t / 1000) % 5 === 0) void refreshLocal($)
      if (workVisible && t >= prsDueAt) void refreshPrs($)
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
    sessionsVisible = shown
    if (shown) void refreshRecent($).catch(() => {})
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
      // Not awaited: a slow git or gh never holds up the turn.
      void refreshLocal($)
      if (workVisible && at - prsStartedAt >= PR_TURN_MS) void refreshPrs($)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Link, Text } = $.ui.resolve(e)
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
    const prState = await read($, prs)
    const diffState = await read($, diff)

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
        ? [...own.map(named), { key: 'agents', text: `agent ×${byAgents.length}`, color: 'cyan', count: byAgents.length }]
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
      const hidden = tight.slice(k).reduce((n, x) => n + (x.count ?? 1), 0)
      layouts.push([[...tight.slice(0, k), { key: 'more', text: `+${hidden}`, color: 'cyan' }], bgCount])
    }
    if (trees.length > 0) layouts.push([[{ key: 'count', text: `×${trees.length}`, color: 'cyan' }], bgCount])
    // Outside a git repository there are no worktrees to speak of, so `wt` is left out rather than shown as none.
    const inRepo = onBranch !== null
    // When not even a count fits, the middle is left empty rather than pushing the line past the edge.
    const fitting = layouts.find(([w, b]) => middleWidth(inRepo ? w : null, b) * scale <= room)

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
    const middleParts = !fitting
      ? []
      : inRepo
        ? [section('wt', fitting[0]), section('bg', fitting[1])]
        : [section('bg', fitting[1])]
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

    // The work row: the open PRs on the left, each with its checks passed out of the total, and the branch's
    // diff against the main branch on the right. Squeezed one step at a time until the whole row fits: titles
    // cut to 32, then to 16, then numbers alone, then a count with the worst mark; failing that, left empty.
    const len = (text: string) => Array.from(text).length
    const prLabel = (p: Pr, max: number | null) => (max === null || p.title === '' ? `#${p.number}` : `#${p.number} ${truncate(p.title, max)}`)
    const checksLabel = (c: Checks) => `${CHECK_MARKS[c.state].mark} ${c.passed}/${c.total}`
    const prWidth = (p: Pr, max: number | null) => len(prLabel(p, max)) + (p.checks ? 1 + len(checksLabel(p.checks)) : 0)
    const listed = prState?.kind === 'ok' ? prState.prs : []
    const stale = prState?.kind === 'ok' && prState.stale
    const worstState = listed.reduce<Checks['state'] | null>(
      (w, p) => (p.checks && (w === null || CHECK_MARKS[p.checks.state].rank > CHECK_MARKS[w].rank) ? p.checks.state : w),
      null,
    )
    const quiet = (text: string) => <Text dimColor>{text}</Text>
    const prSection = (body: RenderChildren[]) => (
      <Box flexWrap="nowrap" columnGap={1}>
        <Text bold>pr</Text>
        {body}
      </Box>
    )
    const markText = (state: Checks['state'], text: string) => (
      <Text color={stale ? undefined : CHECK_MARKS[state].color} dimColor={stale || state === 'unknown'}>
        {text}
      </Text>
    )
    // Each form: its width in cells and what it draws.
    const prForms: [number, RenderChildren][] = []
    if (prState?.kind === 'loading') prForms.push([4, prSection([quiet('…')])])
    else if (prState?.kind === 'unavailable') prForms.push([14, prSection([quiet('unavailable')])])
    else if (prState?.kind === 'ok' && listed.length === 0) prForms.push([7, prSection([quiet('none')])])
    else if (prState?.kind === 'ok') {
      for (const max of [32, 16, null]) {
        const width = 2 + listed.reduce((w, p) => w + 1 + prWidth(p, max), 0) + 2 * (listed.length - 1)
        const items = listed.map(p => (
          <Box key={`pr:${p.number}`} flexWrap="nowrap" columnGap={1}>
            <Link href={p.url}>
              <Text dimColor={p.draft || stale}>{prLabel(p, max)}</Text>
            </Link>
            {p.checks ? markText(p.checks.state, checksLabel(p.checks)) : null}
          </Box>
        ))
        prForms.push([width, prSection(items.flatMap((x, i) => (i === 0 ? [x] : [sep, x])))])
      }
      const count = `×${listed.length}`
      const mark = worstState ? CHECK_MARKS[worstState].mark : ''
      prForms.push([3 + len(count) + (mark ? 1 + len(mark) : 0), prSection([<Text key="n">{count}</Text>, worstState ? markText(worstState, mark) : null])])
    }

    const diffText: string[] =
      diffState?.kind === 'ok' ? (diffState.clean ? ['clean'] : [`+${diffState.added}`, `−${diffState.deleted}`]) : ['unavailable']
    const diffWidth = diffState === null ? 0 : 5 + len(mainBranch) + diffText.reduce((w, x) => w + 1 + len(x), 0)
    const diffPart =
      diffState === null ? null : (
        <Box flexWrap="nowrap" columnGap={1}>
          <Text bold>diff</Text>
          <Text dimColor>{mainBranch}</Text>
          {diffState.kind === 'ok' && !diffState.clean ? (
            <Box columnGap={1}>
              <Text color="green">{diffText[0]}</Text>
              <Text color="red">{diffText[1]}</Text>
            </Box>
          ) : (
            quiet(diffText.join(' '))
          )}
        </Box>
      )
    const workFits = (w: number) => w * scale <= e.props.bodyColumns
    const prPart = prForms.length === 0 ? null : prForms.find(([w]) => workFits(w + (diffPart ? diffWidth + 1 : 0)))?.[1]
    const workLine =
      !workOn || (prForms.length === 0 && diffPart === null) || (prForms.length > 0 && !prPart) || !workFits(diffWidth) ? null : (
        <Box width="100%" flexWrap="nowrap" justifyContent="space-between" columnGap={1}>
          {prPart ?? <Box />}
          {diffPart}
        </Box>
      )

    if (!awayLine && !statusLine && !workLine && !recentLine) {
      return firstLine
    }

    return (
      <Box width="100%" flexDirection="column" rowGap={1}>
        {firstLine}
        {awayLine}
        {statusLine}
        {workLine}
        {recentLine}
      </Box>
    )
  })
}

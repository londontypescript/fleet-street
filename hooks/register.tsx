import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register, RenderChildren } from 'claude-code'

import type { Away, BgTask, Checks, CiRun, Context, DiffState, Limit, Milestone, Pr, PrState, RecentSession, Subagent, Worktree } from '../types'

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
// This session's subagents, running or lately finished.
const agents = atom({ plugin: 'fleet-street', key: 'agents' } as const, [] as Subagent[])
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
// The context is coloured by the worse of its percentage and its size: on a large window a session is worth
// handing over long before the percentage looks high.
const contextColor = (pct: number, tokens: number, warn: number, handover: number) =>
  levelColor(pct) === 'red' || tokens >= handover ? 'red' : levelColor(pct) === 'yellow' || tokens >= warn ? 'yellow' : 'green'

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

// `cd repo && npm run dev -- --port 3000` → `npm run dev -- --port 3000`: a task's label when its call gave no
// description. The row cuts labels to fit.
const shortCommand = (command: string) => {
  const last = command.split(/\s*&&\s*/).filter(part => !/^cd\s/.test(part.trim())).pop() ?? command
  return last.replace(/\s+/g, ' ').trim()
}
// A task by the description its call gave (what the app's own task list shows), else its command.
const taskLabel = (description: string | undefined, command: string) =>
  description?.replace(/\s+/g, ' ').trim() || shortCommand(command)

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
  const ids = new Set([...text.matchAll(/<task-id>([^<]+)<\/task-id>/g)].flatMap(m => (m[1] ? [m[1].trim()] : [])))
  if (ids.size > 0) await setBgTasks($, list => list.filter(b => !ids.has(b.id)))
}

const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
// Effort levels as the banner shortens them.
const EFFORT_SHORT: Record<string, string> = { low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max' }
// A model by its family: claude-opus-5-5 → Opus, gpt-6.1-sol → Sol; anything else cut to 10.
const modelFamily = (model: string) => {
  const claude = /(opus|sonnet|haiku|fable)/i.exec(model)?.[1]
  if (claude) return capitalise(claude)
  const gpt = /gpt-[\d.]+-([a-z]+)/i.exec(model)?.[1]
  return gpt ? capitalise(gpt) : truncate(model, 10)
}
// 'Opus High', 'Sonnet Med', or the family alone until the effort is known; undefined until the model is.
const modelLabel = (model: string | undefined, effort: string | undefined) =>
  model === undefined ? undefined : effort ? `${modelFamily(model)} ${EFFORT_SHORT[effort] ?? effort}` : modelFamily(model)

// A run of another provider's agent through the Codex CLI (codex-locked, or codex exec): its model from
// -m/--model and its effort from model_reasoning_effort, as 'Sol High'; undefined for any other command. Each
// part of a compound command is looked at on its own, so `git commit -m x && codex exec ...` reads codex's -m.
// A command line split into the commands it runs, each as its words, the shell's way as far as this needs:
// quotes keep a word together and are removed, a backslash keeps the next character (inside double quotes, the
// characters the shell lets it), and ; & && || | and
// newlines outside quotes end a command (but not the & of a redirection such as 2>&1).
const shellCommands = (line: string): string[][] => {
  const commands: string[][] = []
  let words: string[] = []
  let word: string | null = null
  let quote: string | null = null
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i)
    if (quote !== null) {
      if (ch === quote) quote = null
      // Inside double quotes a backslash keeps a quote, a backslash, a $ or a backtick as itself.
      else if (quote === '"' && ch === '\\' && /["\\$`]/.test(line.charAt(i + 1))) word = (word ?? '') + line.charAt(++i)
      else word = (word ?? '') + ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      word = word ?? ''
    } else if (ch === '\\' && i + 1 < line.length) {
      word = (word ?? '') + line.charAt(++i)
    } else if (ch === '&' && word !== null && /[<>]$/.test(word)) {
      word += ch
    } else if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      if ((ch === '&' || ch === '|') && line.charAt(i + 1) === ch) i++
      endCommand()
    } else if (/\s/.test(ch)) {
      endWord()
    } else {
      word = (word ?? '') + ch
    }
  }
  endCommand()
  return commands
}

const codexModel = (command: string) => {
  for (const words of shellCommands(command)) {
    // The program the command runs, past any VAR=value and env in front of it.
    let i = 0
    while (i < words.length && (words[i] === 'env' || /^\w+=/.test(words[i] ?? ''))) i++
    const program = words[i]?.split('/').pop()
    const args = words.slice(i + 1)
    if (program !== 'codex-locked' && !(program === 'codex' && args.includes('exec'))) continue
    const flag = args.findIndex(w => w === '-m' || w === '--model')
    const model = (flag >= 0 ? args[flag + 1] : args.find(w => w.startsWith('--model='))?.slice(8)) || 'codex'
    const effort = args.map(w => /^(?:--config=)?model_reasoning_effort\s*=\s*['"]*([a-z]+)/.exec(w)?.[1]).find(Boolean)
    return modelLabel(model, effort)
  }
  return undefined
}

// The model and effort each subagent's latest step asked for, by agent id, and when. Only read from events as
// they pass: nothing hooks a subagent's start, which crashed the mod for subagents in worktrees.
const agentNotes = new Map<string, { model: string; effort?: string; at: number }>()
// How long notes for an agent the list never showed are kept.
const AGENT_NOTE_MS = 10 * 60_000
// When each agent was first seen and first seen finished, and how it last looked.
const agentSeen = new Map<string, { firstSeen: number; endedAt?: number; last?: Subagent }>()
const FINISHED = new Set(['completed', 'failed', 'killed'])
// A finished subagent stays on the row this long, so a quick one is still seen.
const AGENT_DONE_MS = 2 * 60_000

let agentsShown: string | undefined
let agentsRunning = false
let agentsAgain = false
let agentsFailed = false

// The session's subagents from the engine's own list, polled: running ones, and finished ones for two minutes.
async function refreshAgents($: EngineInterface) {
  if (agentsRunning) {
    agentsAgain = true
    return
  }
  agentsRunning = true
  try {
    do {
      agentsAgain = false
      await scanAgents($)
    } while (agentsAgain)
    agentsFailed = false
  } catch (err) {
    if (!agentsFailed) $.ui.log(`fleet-street: agent list failed: ${err}`)
    agentsFailed = true
  } finally {
    agentsRunning = false
  }
}

async function scanAgents($: EngineInterface) {
  const t = Date.now()
  const list = await $.agent.list()
  const ids = new Set<string>()
  for (const a of list) {
    ids.add(a.id)
    const seen = agentSeen.get(a.id) ?? { firstSeen: t }
    // A finished agent may be resumed under its id: it is running again, not finished.
    seen.endedAt = FINISHED.has(a.status) ? (seen.endedAt ?? t) : undefined
    const noted = agentNotes.get(a.id)
    seen.last = {
      id: a.id,
      description: (a.description || a.name || a.type).replace(/\s+/g, ' ').trim(),
      status: a.status,
      model: modelLabel(noted?.model, noted?.effort),
      firstSeen: seen.firstSeen,
      endedAt: seen.endedAt,
    }
    agentSeen.set(a.id, seen)
  }
  const expired = (s: { endedAt?: number }) => s.endedAt !== undefined && t - s.endedAt > AGENT_DONE_MS
  for (const [id, seen] of agentSeen) {
    // One the engine has dropped stays as it was last seen, finished, for the rest of its two minutes.
    if (!ids.has(id) && seen.last) {
      seen.endedAt ??= t
      seen.last = { ...seen.last, status: FINISHED.has(seen.last.status) ? seen.last.status : 'completed', endedAt: seen.endedAt }
    }
    // Kept while the engine lists it, so an expired one isn't taken for new; hidden once expired.
    if (!ids.has(id) && expired(seen)) {
      agentSeen.delete(id)
      // Notes taken after it finished belong to it resumed, and stay for its next listing.
      const noted = agentNotes.get(id)
      if (noted && noted.at <= (seen.endedAt ?? 0)) agentNotes.delete(id)
    }
  }
  // Notes for an agent never listed (it came and went between polls) go once they're stale.
  for (const [id, noted] of agentNotes) {
    if (!agentSeen.has(id) && !ids.has(id) && t - noted.at > AGENT_NOTE_MS) agentNotes.delete(id)
  }
  const found = [...agentSeen.values()].flatMap(s => (s.last && !expired(s) ? [s.last] : []))
  const key = JSON.stringify(found)
  if (key !== agentsShown) {
    agentsShown = key
    await update($, agents, () => found)
  }
}

// A subagent's step names its model and effort before its request goes; noted, and the list refreshed when
// that's news or the agent is new.
function noteAgentStep($: EngineInterface, id: string, model: string, effort: string | undefined) {
  const noted = agentNotes.get(id)
  agentNotes.set(id, { model, effort, at: Date.now() })
  // A step means it's running: a finished one has been resumed.
  const seen = agentSeen.get(id)
  if (seen) seen.endedAt = undefined
  if (!agentSeen.has(id) || noted?.model !== model || noted.effort !== effort) void refreshAgents($)
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

// East Asian wide characters and emoji take two terminal cells; everything else one. The symbol blocks
// (misc symbols, dingbats) are counted wide whole: some are narrow, but counting wide only cuts a title sooner.
const WIDE = /[\u1100-\u115f\u231a\u231b\u23e9-\u23f3\u2600-\u27bf\u2b50\u2b55\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{1f000}-\u{1faff}\u{20000}-\u{3fffd}]/u
const cellsOf = (ch: string) => (WIDE.test(ch) ? 2 : 1)
const cells = (text: string) => Array.from(text).reduce((w, ch) => w + cellsOf(ch), 0)

// Cut to at most max cells, by characters rather than UTF-16 units, so an emoji is never split in half.
const truncate = (text: string, max: number) => {
  if (max <= 0) return ''
  if (cells(text) <= max) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    if (used + cellsOf(ch) > max - 1) break
    out += ch
    used += cellsOf(ch)
  }
  return `${out.trimEnd()}…`
}

// A desktop draws proportional text, which takes about this share of the cells its length suggests.
const DESKTOP_TEXT_SCALE = 0.85

// The app names a subagent's worktree branch worktree-agent-<id>.
const AGENT_BRANCH = /^worktree-agent-([0-9a-f]{7})[0-9a-f]*$/

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

// A PR opens in the browser through the same openers. A terminal without OSC 8 links would print a Link's URL
// after its text, so PRs are Buttons instead. The OS is known only once the desktop app's folder was found;
// otherwise Windows is told by APPDATA, and macOS's opener is tried before Linux's.
const openUrl = async ($: EngineInterface, url: string) => {
  const os = sessionsRoot?.os ?? ((await $.env.get('APPDATA')) ? 'windows' : undefined)
  const tries = os ? [OPENERS[os](url)] : [OPENERS.macos(url), OPENERS.linux(url)]
  for (const argv of tries) {
    const ran = await $.process.run(argv).catch(() => null)
    if (ran && ran.exitCode === 0) return
  }
  $.ui.toast(`Could not open ${url}`)
}

const openSession = async ($: EngineInterface, link: string) => {
  if (!sessionsRoot) return
  const ran = await $.process.run(OPENERS[sessionsRoot.os](link)).catch(err => ({ exitCode: 1, stderr: String(err) }))
  if (ran.exitCode !== 0) $.ui.toast(`Could not open session: ${ran.stderr.slice(0, 80)}`)
}

// Set from the options when the session starts.
let mainBranchName = 'main'
// The milestone the ms row follows, by its title; empty to pick one.
let milestoneName = ''
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
// undefined until the first publish, which always goes through: the state outlives a hot reload of this module.
let worktreesShown: string | undefined
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
  if (!ok(others) || others.isStdoutTruncated) return { kind: 'unavailable' }
  const untracked = others.stdout.split('\0').filter(Boolean)
  if (untracked.length > 0) {
    // `<path>\0<lines>` per text file with any lines; binaries (-I) and empty files are left out, and git
    // exits 1 when that leaves nothing.
    const counted = await git('--literal-pathspecs', 'grep', '--untracked', '--no-color', '-I', '-c', '-z', '', '--', ...untracked.slice(0, UNTRACKED_COUNTED))
    if (counted === null || counted.exitCode > 1 || counted.isStdoutTruncated) return { kind: 'unavailable' }
    if (counted.exitCode === 0) {
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
const PR_FIELDS = 'number,title,url,headRefName,baseRefName,isDraft,isCrossRepository,mergeable,statusCheckRollup'
// The checks a base branch requires (its rulesets' and its classic protection's) are fetched again this often.
const REQUIRED_MS = 5 * 60_000
// A resource is fetched again this often while any of its checks or runs are going, else this often; a
// rate-limit reply holds off every fetch for the third.
const PR_FAST_MS = 15_000
const PR_SLOW_MS = 60_000
const PR_BACKOFF_MS = 5 * 60_000

// A check run's conclusion, or a legacy status context's state, that counts as failed or passed.
const CHECK_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE', 'ERROR'])
const CHECK_PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
// The colour of an agent's model and effort on the ag row.
const MODEL_COLOR = '#f28c28'

// How a subagent's status is drawn, and which wins when one mark stands for several.
const AGENT_MARKS: Record<Subagent['status'], { mark: string; color: string | undefined; rank: number }> = {
  failed: { mark: '✗', color: 'red', rank: 4 },
  killed: { mark: '✗', color: 'red', rank: 4 },
  running: { mark: '●', color: 'yellow', rank: 3 },
  pending: { mark: '○', color: undefined, rank: 2 },
  waiting: { mark: '○', color: undefined, rank: 2 },
  idle: { mark: '○', color: undefined, rank: 1 },
  completed: { mark: '✓', color: 'green', rank: 0 },
}
// How each result is drawn, and which wins when a count stands for several PRs.
const CHECK_MARKS: Record<Checks['state'], { mark: string; color: string | undefined; rank: number }> = {
  fail: { mark: '✗', color: 'red', rank: 4 },
  running: { mark: '●', color: 'yellow', rank: 3 },
  waiting: { mark: '○', color: 'yellow', rank: 2 },
  unknown: { mark: '?', color: undefined, rank: 1 },
  pass: { mark: '✓', color: 'green', rank: 0 },
}

// statusCheckRollup mixes check runs (`status`, then `conclusion` once COMPLETED) with legacy status
// contexts (`state`), and keeps every run: a re-run's superseded (often cancelled) run stays beside it. As on
// GitHub's own page, only the latest run of each check counts: by workflow and name, or a status's context.
// A failure wins over running checks; a value not known here makes the result unknown.
const latestChecks = (rollup: Record<string, unknown>[]) => {
  // ISO times compare as strings. A run not started yet (no time, or GitHub's zero time 0001-01-01) is a
  // queued re-run, so it counts as the latest; between two such, the later in the rollup's order. One that
  // finished without starting (cancelled while queued) goes by when it finished, so its re-run still wins.
  const timeOf = (value: unknown) => {
    const at = String(value ?? '')
    return at === '' || at.startsWith('0001-') ? null : at
  }
  const startOf = (c: Record<string, unknown>) =>
    timeOf(c.startedAt) ?? (c.status === 'COMPLETED' ? (timeOf(c.completedAt) ?? '') : '\uffff')
  const latest = new Map<string, Record<string, unknown>>()
  for (const c of rollup) {
    const key = `${String(c.workflowName ?? '')}\0${String(c.name ?? c.context ?? '')}`
    const kept = latest.get(key)
    if (!kept || startOf(c) >= startOf(kept)) latest.set(key, c)
  }
  return [...latest.values()]
}

// required: the check names the PR's base branch requires; those not reported yet count as missing, in the
// total but not passed. A PR in conflict never gets them: the workflows a pull_request event starts don't run.
const summariseChecks = (raw: unknown, required: string[] = []): Checks | null => {
  const rollup = latestChecks(Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [])
  const reported = new Set(rollup.map(c => String(c.name ?? c.context ?? '')))
  const missing = required.filter(r => !reported.has(r)).length
  if (rollup.length === 0 && missing === 0) return null
  let passed = 0
  let failed = 0
  let running = 0
  let unknown = 0
  const failedNames: string[] = []
  for (const c of rollup) {
    const legacy = c.__typename === 'StatusContext' || (c.status === undefined && typeof c.state === 'string')
    const done = legacy ? c.state !== 'PENDING' && c.state !== 'EXPECTED' : c.status === 'COMPLETED'
    const result = String((legacy ? c.state : c.conclusion) ?? '')
    if (!done && (legacy || typeof c.status === 'string')) running++
    else if (CHECK_PASSED.has(result)) passed++
    else if (CHECK_FAILED.has(result)) {
      failed++
      failedNames.push(String(c.name ?? c.context ?? '').replace(/\s+/g, ' ').trim() || '?')
    } else unknown++
  }
  const state = failed > 0 ? 'fail' : running > 0 ? 'running' : missing > 0 ? 'waiting' : unknown > 0 ? 'unknown' : 'pass'
  return { passed, total: rollup.length + missing, state, running: running > 0, failed: failedNames, ...(missing > 0 ? { missing } : {}) }
}

// A run's jobs as `gh run view --json jobs` gives them (lower case), in the rollup's shape (upper case).
const jobChecks = (raw: unknown): Checks | null =>
  Array.isArray(raw)
    ? summariseChecks(
        (raw as Record<string, unknown>[]).map(j => ({
          name: j.name,
          status: String(j.status ?? '').toUpperCase(),
          conclusion: String(j.conclusion ?? '').toUpperCase(),
          startedAt: j.startedAt,
          completedAt: j.completedAt,
        })),
      )
    : null

// The runs on the ci row: those a push, a dispatch, a release or a schedule started (a PR's are on its own
// row; CodeQL's and issue triggers' are noise). Only each workflow's latest, while running and for a while
// after it finishes, at most this many.
const CI_EVENTS = new Set(['push', 'workflow_dispatch', 'release', 'schedule', 'merge_group', 'repository_dispatch'])
const CI_RUNS = 3
const CI_DONE_MS = 10 * 60_000
const RUN_FIELDS = 'databaseId,workflowDatabaseId,workflowName,event,status,conclusion,url,updatedAt'
// Runs listed per refresh: enough that a burst of PR runs doesn't push a running release check off the list.
const RUN_LIST = '100'

const pickRuns = (list: Record<string, unknown>[], t: number) => {
  const picked: Record<string, unknown>[] = []
  const seen = new Set<string>()
  // gh lists the newest first. Workflows go by id: two files may share a name. A skipped latest run still
  // counts as the latest, so an older result doesn't show in its place.
  for (const r of list) {
    const workflow = String(r.workflowDatabaseId ?? r.workflowName ?? '')
    if (!CI_EVENTS.has(String(r.event)) || seen.has(workflow)) continue
    seen.add(workflow)
    if (r.conclusion === 'skipped') continue
    if (r.status === 'completed' && t - Date.parse(String(r.updatedAt)) >= CI_DONE_MS) continue
    picked.push(r)
  }
  return picked.slice(0, CI_RUNS)
}

// A run's own result outranks its jobs': one that failed to start has no jobs, and a cancelled one may have
// only passed jobs.
const withRunResult = (checks: Checks | null, status: string, conclusion: string): Checks | null => {
  const failed = status === 'completed' && CHECK_FAILED.has(conclusion.toUpperCase())
  if (!failed) return checks
  return { passed: 0, total: 0, running: false, failed: [], ...checks, state: 'fail' }
}

// A version-like title (0.2.0, v1.4) as numbers to compare by; null when it isn't one.
const versionOf = (title: string) => {
  const m = /^v?(\d+(?:\.\d+)*)/i.exec(title.trim())
  return m?.[1] ? m[1].split('.').map(Number) : null
}
const compareVersions = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
// The milestone being worked on: the one the `milestone` option names, else the open one with the lowest
// version, else the open one made first. Null when the repository has none open.
const pickMilestone = (list: Record<string, unknown>[], named: string): Milestone | null => {
  const chosen =
    list.find(m => named !== '' && m.title === named) ??
    list
      .filter(m => versionOf(String(m.title)) !== null)
      .sort((a, b) => compareVersions(versionOf(String(a.title)) ?? [], versionOf(String(b.title)) ?? []))[0] ??
    [...list].sort((a, b) => Number(a.number) - Number(b.number))[0]
  if (!chosen) return null
  const closed = Number(chosen.closed_issues ?? 0)
  return {
    title: String(chosen.title),
    url: String(chosen.html_url ?? ''),
    closed,
    total: closed + Number(chosen.open_issues ?? 0),
    headline: headlineOf(String(chosen.description ?? '')),
  }
}

// A milestone's description cut to its headline: the words before its first colon (`Agent rules and the merge
// loop: our AGENTS.md uses…`), else its first sentence. A footer after a `---` line is dropped first.
const headlineOf = (description: string) => {
  const body = description.split(/^\s*-{3,}\s*$/m)[0] ?? ''
  const text = body.replace(/\s+/g, ' ').trim()
  // A colon past the first sentence isn't the headline's.
  const colon = /^(.+?):\s/.exec(text)?.[1]?.match(/^(?!.*[.!?]\s).*$/)?.[0]
  return (colon ?? /^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text).trim()
}

// GitHub answers are shared by every session through small files, one per resource: the open PRs of each
// branch, the open milestones, the latest runs, and each base branch's required checks from each source. Every
// session runs its own copy of this mod, so without them four sessions on one repository asked GitHub the same
// things four times. Each file holds its last good answer and when it came (`at`), the last failure and when
// (`failedAt`), and when a session last set out to fetch it (`attemptAt`). A session fetches a resource only
// when its answer is due and no other session set out for it in the last ATTEMPT_MS; two sessions that set out
// at once both fetch, which costs a request but never a wrong answer. A file torn by a crash or by two writers
// fails to parse and counts as missing, so it's fetched again.
type PrFail = { kind: 'unavailable' | 'stale' | 'rate'; reason: string }
// askedAt: when the fetch that gave the answer set out, which says which of two answers is newer.
type Shared<T> = { v: 1; at: number; askedAt?: number; failedAt: number; failure: PrFail | null; attemptAt: number; data: T | null }
// A PR as shared: its checks are summarised by each session against the required checks it reads.
type SharedPr = Omit<Pr, 'checks'> & { base: string; rollup: unknown }

// Another session's fetch is waited for this long; a fetch is up to two gh calls of 15 s at most.
const ATTEMPT_MS = 30_000
// A failed fetch is tried again after this long (a rate limit holds off every fetch for PR_BACKOFF_MS).
const RETRY_MS = 60_000
// An answer this old counts as stale whatever the failures say: whoever was fetching it has stopped.
const SHARED_STALE_MS = 5 * 60_000
// A required-checks answer that can't be refreshed counts for this long, then for nothing.
const REQUIRED_KEEP_MS = 30 * 60_000
// At most this many fetches run at once in one session.
const FETCHES = 4

// The check names a ruleset (`rules/branches/<base>`) requires.
const rulesetNames = (rules: unknown) => {
  const names: string[] = []
  if (Array.isArray(rules)) {
    for (const r of rules as Record<string, unknown>[]) {
      const checks = r.type === 'required_status_checks' ? (r.parameters as Record<string, unknown> | null)?.required_status_checks : null
      if (Array.isArray(checks)) for (const c of checks as Record<string, unknown>[]) names.push(String(c.context ?? ''))
    }
  }
  return names.filter(Boolean)
}
// The check names classic branch protection (`branches/<base>`) requires.
const classicNames = (branchInfo: unknown) => {
  const classic = ((branchInfo as Record<string, unknown> | null)?.protection as Record<string, unknown> | undefined)?.required_status_checks as
    | Record<string, unknown>
    | undefined
  const names: string[] = []
  if (Array.isArray(classic?.contexts)) names.push(...(classic.contexts as unknown[]).map(String))
  if (Array.isArray(classic?.checks)) names.push(...(classic.checks as Record<string, unknown>[]).map(c => String(c.context ?? '')))
  return names.filter(Boolean)
}
const REQUIRED_SOURCES = [
  { id: 'rules', path: (slug: string, b: string) => `repos/${slug}/rules/branches/${encodeURIComponent(b)}`, names: rulesetNames },
  { id: 'classic', path: (slug: string, b: string) => `repos/${slug}/branches/${encodeURIComponent(b)}`, names: classicNames },
]

// FNV-1a, as eight hex digits: a branch's file name, so `feat/x` and `Feat/x` never share one.
const hashOf = (text: string) => {
  let h = 0x811c9dc5
  for (const ch of text) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
// A readable, safe start of the name for whoever looks in the folder, then its hash.
const fileName = (kind: string, name: string) => `${kind}-${name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40)}-${hashOf(name)}.json`

// The folder the shared files go in: fleet-street/github under Claude's configuration folder (CLAUDE_CONFIG_DIR,
// else .claude in the home folder), else the plugin's own .cache. One folder per repository, by its slug in
// lower case, as GitHub's names are.
let cacheRoot: string | undefined
async function sharedRoot($: EngineInterface) {
  if (cacheRoot === undefined) {
    const config = await $.env.get('CLAUDE_CONFIG_DIR')
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
    const base = config || (home ? `${home.replace(/[\\/]+$/, '')}/.claude` : `${$.plugin.root}/.cache`)
    cacheRoot = `${base.replace(/[\\/]+$/, '')}/fleet-street/github`
  }
  return cacheRoot
}
const repoFolder = async ($: EngineInterface, slug: string) => `${await sharedRoot($)}/${slug.toLowerCase().replace('/', '__')}`

// The last good copy of each file this session read or wrote, for when the file can't be read or parsed.
const sharedKnown = new Map<string, Shared<unknown>>()
let cacheLogged = ''
const logCache = ($: EngineInterface, what: string) => {
  if (what !== cacheLogged) {
    cacheLogged = what
    $.ui.log(`fleet-street: shared cache: ${what}`)
  }
}

async function readShared<T>($: EngineInterface, path: string): Promise<Shared<T> | null> {
  try {
    const s = JSON.parse(await $.fs.read(path)) as Shared<T>
    if (s?.v === 1 && typeof s.at === 'number' && typeof s.failedAt === 'number' && typeof s.attemptAt === 'number') {
      sharedKnown.set(path, s)
      return s
    }
  } catch {
    // Missing, or torn: what this session last saw stands in, else nothing.
  }
  return (sharedKnown.get(path) as Shared<T> | undefined) ?? null
}

async function writeShared<T>($: EngineInterface, path: string, s: Shared<T>) {
  sharedKnown.set(path, s)
  await $.fs.write(path, JSON.stringify(s)).catch(err => logCache($, `could not write ${path}: ${err}`))
}

const EMPTY: Shared<never> = { v: 1, at: 0, failedAt: 0, failure: null, attemptAt: 0, data: null }

// Whether a resource needs fetching: never fetched, its answer older than `every`, or its last failure older
// than RETRY_MS; but not while another session set out for it less than ATTEMPT_MS ago.
const isDue = (s: Shared<unknown> | null, every: number, t: number) => {
  if (!s) return true
  if (s.attemptAt > Math.max(s.at, s.failedAt) && t - s.attemptAt < ATTEMPT_MS) return false
  return s.failedAt > s.at ? t - s.failedAt >= RETRY_MS : t - s.at >= every
}

// The account's rate limit is shared by every repository, so a rate-limit reply holds off every fetch.
const backoffFile = async ($: EngineInterface) => `${await sharedRoot($)}/backoff.json`

// Fetches one resource: marks the file as being fetched, runs `fetch`, and writes its answer or its failure,
// keeping the last good answer. An answer that lands after one from a fetch that set out later is dropped.
async function fetchShared<T>($: EngineInterface, path: string, fetch: (before: T | null) => Promise<{ data: T } | { failure: PrFail }>) {
  const started = Date.now()
  const before = (await readShared<T>($, path)) ?? EMPTY
  await writeShared($, path, { ...before, attemptAt: started })
  const got = await fetch(before.data)
  const now = (await readShared<T>($, path)) ?? before
  const newer = (now.askedAt ?? 0) > started
  if ('data' in got) {
    if (newer) return
    await writeShared($, path, { ...now, v: 1, at: Date.now(), askedAt: started, failure: null, data: got.data })
    return
  }
  if (got.failure.kind === 'rate') {
    await $.fs.write(await backoffFile($), JSON.stringify({ until: Date.now() + PR_BACKOFF_MS })).catch(() => {})
  }
  if (newer) return
  await writeShared($, path, { ...now, failedAt: Date.now(), failure: got.failure })
}

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

type GhRan = { run: ProcessRunResult } | { error: string }
// A gh answer as JSON, or why there's none.
const ghJson = (slug: string, ran: GhRan): { data: unknown } | { failure: PrFail } => {
  const f = classifyGh(slug, ran)
  if (f) return { failure: f }
  try {
    return { data: JSON.parse((ran as { run: ProcessRunResult }).run.stdout) }
  } catch {
    return { failure: { kind: 'stale', reason: 'gh gave an unreadable reply' } }
  }
}

// One `gh pr list --head` per branch, so a repository with hundreds of open PRs can't push these off the first
// page. PRs from forks are dropped: a fork's branch may share a name with one here.
const fetchBranch = (slug: string, gh: (...a: string[]) => Promise<GhRan>, b: string) => async () => {
  const got = ghJson(slug, await gh('pr', 'list', '-R', slug, '--head', b, '--state', 'open', '--limit', '20', '--json', PR_FIELDS))
  if (!('data' in got)) return got
  if (!Array.isArray(got.data)) return { failure: { kind: 'stale', reason: 'gh gave an unreadable reply' } as PrFail }
  const prs: SharedPr[] = []
  for (const p of got.data as Record<string, unknown>[]) {
    if (p.isCrossRepository || p.headRefName !== b || prs.some(x => x.number === p.number)) continue
    prs.push({
      number: Number(p.number),
      title: String(p.title ?? '').replace(/\s+/g, ' ').trim(),
      url: String(p.url ?? ''),
      branch: b,
      draft: Boolean(p.isDraft),
      conflict: p.mergeable === 'CONFLICTING',
      base: String(p.baseRefName ?? ''),
      rollup: p.statusCheckRollup,
    })
  }
  return { data: prs }
}

// The latest runs a push, a dispatch, a release or a schedule started, each with its jobs. A run whose jobs
// can't be read keeps the jobs last read for it.
const fetchRuns = (slug: string, gh: (...a: string[]) => Promise<GhRan>) => async (before: CiRun[] | null) => {
  const got = ghJson(slug, await gh('run', 'list', '-R', slug, '--limit', RUN_LIST, '--json', RUN_FIELDS))
  if (!('data' in got)) return got
  if (!Array.isArray(got.data)) return { failure: { kind: 'stale', reason: 'gh gave an unreadable reply' } as PrFail }
  const picked = pickRuns(got.data as Record<string, unknown>[], Date.now())
  const jobs = await Promise.all(picked.map(r => gh('run', 'view', String(r.databaseId), '-R', slug, '--json', 'jobs')))
  // A rate limit on any of them holds every fetch off, as one on the list does.
  const limited = jobs.map(j => classifyGh(slug, j)).find(f => f?.kind === 'rate')
  if (limited) return { failure: limited }
  const runs: CiRun[] = picked.map((r, i) => {
    const id = Number(r.databaseId)
    const answer = ghJson(slug, jobs[i] as GhRan)
    return {
      id,
      workflow: String(r.workflowName ?? ''),
      url: String(r.url ?? ''),
      checks: withRunResult(
        'data' in answer ? jobChecks((answer.data as { jobs?: unknown } | null)?.jobs) : (before?.find(x => x.id === id)?.checks ?? null),
        String(r.status ?? ''),
        String(r.conclusion ?? ''),
      ),
      ...(r.status === 'completed' ? { doneAt: Date.parse(String(r.updatedAt)) } : {}),
    }
  })
  return { data: runs }
}

let prsRunning = false
let prsAgain = false
// The fetches this session has running, by file, and when it last set out for each: never again within
// PR_FAST_MS, so a file that can't be written (and so always looks due) can't set off a run of fetches.
const fetching = new Set<string>()
const fetchedAt = new Map<string, number>()
let prsShown = ''
let prsLogged = ''

async function refreshPrs($: EngineInterface) {
  if (prsRunning) {
    prsAgain = true
    return
  }
  prsRunning = true
  try {
    do {
      prsAgain = false
      await syncPrs($)
    } while (prsAgain)
  } catch (err) {
    $.ui.log(`fleet-street: PR refresh failed: ${err}`)
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

// Reads the shared files this session needs, draws from them, and sets out to fetch the ones that are due.
// Called every few seconds, at a turn's end and when the branches change; it never waits for GitHub: a
// fetch, once its answer is written, calls this again.
async function syncPrs($: EngineInterface) {
  const ctx = repoContext
  if (!workVisible || ctx === null || ctx.slug === null) {
    await setPrs($, null)
    return
  }
  const slug = ctx.slug
  const key = contextKey(ctx)
  const folder = await repoFolder($, slug)
  const t = Date.now()

  const branchFiles = ctx.branches.map(b => ({ branch: b, path: `${folder}/${fileName('pr', b)}` }))
  const milestonesPath = `${folder}/milestones.json`
  const runsPath = `${folder}/runs.json`
  const branchAnswers = await Promise.all(branchFiles.map(f => readShared<SharedPr[]>($, f.path)))
  const milestones = await readShared<Record<string, unknown>[]>($, milestonesPath)
  const runsAnswer = await readShared<CiRun[]>($, runsPath)
  const found = branchAnswers.flatMap((s, i) => (s?.data ?? []).filter(p => p.branch === branchFiles[i]?.branch))
  const bases = [...new Set(found.map(p => p.base).filter(Boolean))]
  const requiredFiles = bases.flatMap(b => REQUIRED_SOURCES.map(s => ({ base: b, source: s, path: `${folder}/${fileName(`required-${s.id}`, b)}` })))
  const requiredAnswers = await Promise.all(requiredFiles.map(f => readShared<string[]>($, f.path)))
  if (contextKey(repoContext) !== key) return

  // Draw. The PRs go by what each branch's file last held; the row is stale while any of them has failed since
  // or is too old, and unavailable when none has an answer and one says GitHub can't give one.
  const requiredFor = (base: string) => [
    ...new Set(
      requiredFiles.flatMap((f, i) => {
        const s = requiredAnswers[i]
        return f.base === base && s?.data && t - s.at < REQUIRED_KEEP_MS ? s.data : []
      }),
    ),
  ]
  const prsFound: Pr[] = found.map(({ base, rollup, ...p }) => ({ ...p, checks: summariseChecks(rollup, requiredFor(base)) }))
  const answered = branchAnswers.filter((s): s is Shared<SharedPr[]> => s !== null && s.at > 0)
  const failure = branchAnswers.find(s => s?.failure && s.failedAt > s.at)?.failure ?? null
  const runList = runsAnswer?.data ?? []
  const shownMilestone = Array.isArray(milestones?.data) ? pickMilestone(milestones.data, milestoneName) : null
  if (answered.length === 0 && failure) {
    if (failure.reason !== prsLogged) {
      prsLogged = failure.reason
      $.ui.log(`fleet-street: PRs unavailable: ${failure.reason}`)
    }
    await setPrs($, { kind: 'unavailable', reason: failure.reason })
  } else if (answered.length === 0 && branchFiles.length > 0) {
    await setPrs($, { kind: 'loading' })
  } else {
    prsLogged = ''
    // The milestone and the runs count too: an answer of theirs that has failed since or is too old dims the rows.
    const old = (s: Shared<unknown> | null) => s !== null && s.at > 0 && (s.failedAt > s.at || t - s.at >= SHARED_STALE_MS)
    const stale = failure !== null || answered.some(s => t - s.at >= SHARED_STALE_MS) || old(milestones) || old(runsAnswer)
    await setPrs($, { kind: 'ok', prs: prsFound, runs: runList, milestone: shownMilestone, stale })
  }

  // Fetch what's due, unless a rate-limit reply holds every fetch off.
  const backoff = await $.fs
    .read(await backoffFile($))
    .then(text => Number((JSON.parse(text) as { until?: unknown }).until) || 0)
    .catch(() => 0)
  if (t < backoff) return
  const gh = (...args: string[]) =>
    $.process
      .run(['gh', ...args], { cwd: ctx.top, timeoutMs: 15_000, env: { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } })
      .then(run => ({ run }), err => ({ error: String(err) }))
  const pace = (running: boolean) => (running ? PR_FAST_MS : PR_SLOW_MS)
  const due: { path: string; run: () => Promise<void> }[] = []
  branchFiles.forEach((f, i) => {
    const s = branchAnswers[i] ?? null
    const running = (s?.data ?? []).some(p => summariseChecks(p.rollup)?.running)
    if (isDue(s, pace(running), t)) due.push({ path: f.path, run: () => fetchShared($, f.path, fetchBranch(slug, gh, f.branch)) })
  })
  if (isDue(milestones, PR_SLOW_MS, t)) {
    due.push({
      path: milestonesPath,
      run: () =>
        fetchShared($, milestonesPath, async () => {
          const got = ghJson(slug, await gh('api', `repos/${slug}/milestones?state=open&per_page=100`))
          return 'data' in got && !Array.isArray(got.data) ? { failure: { kind: 'stale', reason: 'gh gave an unreadable reply' } } : (got as { data: Record<string, unknown>[] } | { failure: PrFail })
        }),
    })
  }
  if (isDue(runsAnswer, pace(runList.some(r => r.doneAt === undefined)), t)) {
    due.push({ path: runsPath, run: () => fetchShared($, runsPath, fetchRuns(slug, gh)) })
  }
  requiredFiles.forEach((f, i) => {
    if (!isDue(requiredAnswers[i] ?? null, REQUIRED_MS, t)) return
    due.push({
      path: f.path,
      run: () =>
        fetchShared($, f.path, async () => {
          const got = ghJson(slug, await gh('api', f.source.path(slug, f.base)))
          return 'data' in got ? { data: f.source.names(got.data) } : got
        }),
    })
  })
  for (const d of due) {
    if (fetching.size >= FETCHES) break
    if (fetching.has(d.path) || t - (fetchedAt.get(d.path) ?? 0) < PR_FAST_MS) continue
    fetching.add(d.path)
    fetchedAt.set(d.path, t)
    void d
      .run()
      .catch(err => logCache($, `fetch failed: ${err}`))
      .finally(() => {
        fetching.delete(d.path)
        void refreshPrs($)
      })
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
  const showSessions = options.showSessions === true
  const workOn = options.showWork !== false
  workVisible = workOn
  mainBranchName = mainBranch
  milestoneName = String(options.milestone ?? '').trim()
  const contextWarn = Number(options.contextWarnTokens ?? 300_000)
  const contextHandover = Number(options.contextHandoverTokens ?? 450_000)
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
    void refreshAgents($)
    void refreshRecent($).catch(err => $.ui.log(`fleet-street: recent sessions failed: ${err}`))
    $.clock.every(1000, () => {
      const t = Date.now()
      // A checkout made outside the session (another terminal) shows within five seconds.
      if (Math.floor(t / 1000) % 5 === 0) void refreshLocal($)
      // A safety net: subagents are refreshed as their steps and turns come.
      if (Math.floor(t / 1000) % 5 === 0) void refreshAgents($)
      // The shared files are read every five seconds; what they say decides when GitHub is asked.
      if (workVisible && Math.floor(t / 1000) % 5 === 0) void refreshPrs($)
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
      const task: BgTask = { id, label: taskLabel(e.description, e.command), startedAt, model: codexModel(e.command) }
      await setBgTasks($, list => [...list.filter(b => b.id !== id), task])
    }
    return result
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const result = await next(e)
    const id = result.result && !result.isError ? result.result.taskId : undefined
    if (id) {
      const task: BgTask = { id, label: `monitor ${e.description}`, startedAt: Date.now() }
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
          .map(l => ({
            id: l.id,
            label: taskLabel(l.description, l.command ?? ''),
            startedAt: Date.now(),
            model: l.command ? codexModel(l.command) : undefined,
          }))
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
    if (e.agentId !== undefined) noteAgentStep($, e.agentId, e.model, typeof e.effort === 'string' ? e.effort : undefined)
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
      if (workVisible) void refreshPrs($)
    } else {
      // A subagent's turn ended: it may have finished.
      void refreshAgents($)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    // The clock's ticks set `now` to redraw, but they fall behind while the engine is busy; every redraw uses
    // the real time.
    const t = Math.max(await read($, now), Date.now())
    const ls = await read($, limits)
    const ctx = await read($, context)
    const last = await read($, lastResponseAt)
    const started = await read($, timerStart)
    const gap = await read($, away)
    const trees = await read($, worktrees)
    const onBranch = await read($, branch)
    const bg = await read($, bgTasks)
    const subagents = await read($, agents)
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
      const color = contextColor(pct, ctx.tokens ?? 0, contextWarn, contextHandover)
      parts.push(
        <Box columnGap={1}>
          <Text bold>ctx</Text>
          <Text color={color}>
            {fmtTokens(ctx.tokens ?? 0)}/{fmtTokens(ctx.window)}
          </Text>
          <Text color={color}>{pct}%</Text>
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
    const span = (ms: number) => (ms < 60_000 ? '<1m' : fmtElapsed(ms))
    const scale = e.surface === 'terminal' ? 1 : DESKTOP_TEXT_SCALE
    // Whether a line of this much text and this many gap columns fits: a desktop's proportional text takes fewer
    // cells than its length, but a Box's gaps are whole columns on every surface.
    type Width = { text: number; gaps: number }
    const fits = (w: Width) => w.text * scale + w.gaps <= e.props.bodyColumns

    // The list rows (ag, bg, wt, pr, ci) are drawn only when they have something. Each is a label and its entries,
    // squeezed one step at a time until the row fits, and left out when even the last step doesn't.
    type Part = { text: string; color?: string; dim?: boolean; press?: () => void }
    type Piece = { key: string; parts: Part[] }
    // The label, then each entry with the gap before it, its parts with a gap between each, and each │ with the
    // gap after it.
    const piecesWidth = (label: string, pieces: Piece[]): Width => ({
      text: cells(label) + pieces.reduce((w, p) => w + p.parts.reduce((n, x) => n + cells(x.text), 0), 0) + Math.max(0, pieces.length - 1),
      gaps:
        pieces.reduce((w, p) => w + 1 + p.parts.length - 1, 0) +
        Math.max(0, pieces.length - 1),
    })
    // A pressable part (a PR's title) is a plain button: it reads as text and shows it's pressable on hover.
    const drawPieces = (pieces: Piece[]) =>
      pieces.flatMap((p, i) => {
        const piece = (
          <Box key={p.key} flexWrap="nowrap" alignItems="center" columnGap={1}>
            {p.parts.map((x, j) =>
              x.press ? (
                <Button key={`${p.key}:${j}`} label={x.text} plain dimColor={x.dim} onPress={x.press} />
              ) : (
                <Text key={`${p.key}:${j}`} color={x.color} dimColor={x.dim}>
                  {x.text}
                </Text>
              ),
            )}
          </Box>
        )
        return i === 0 ? [piece] : [sep, piece]
      })
    // The first layout that fits, its label on the left and its entries in columns across the rest of the width,
    // each centred in its own with the │ between them. The spare width is shared evenly between the columns, so
    // a longer entry gets a wider one.
    const listPart = (label: string, layouts: Piece[][]) => {
      const fit = layouts.find(ps => fits(piecesWidth(label, ps)))
      if (!fit) return null
      return (
        <Box width="100%" flexWrap="nowrap" alignItems="center" columnGap={1}>
          <Text bold>{label}</Text>
          {fit.flatMap((p, i) => {
            const column = (
              <Box key={`c:${p.key}`} flexGrow={1} flexWrap="nowrap" justifyContent="center">
                {drawPieces([p])}
              </Box>
            )
            return i === 0 ? [column] : [sep, column]
          })}
        </Box>
      )
    }
    // The first k entries and a piece standing for the rest, k from all but one down to one.
    const firstAndRest = (pieces: Piece[], rest: (hidden: Piece[]) => Piece) =>
      Array.from({ length: Math.max(0, pieces.length - 1) }, (_, i) => {
        const k = pieces.length - 1 - i
        return [...pieces.slice(0, k), rest(pieces.slice(k))]
      })
    const countPiece = (n: number, color: string | undefined, ...more: Part[]): Piece => ({
      key: 'count',
      parts: [{ text: `×${n}`, color }, ...more],
    })
    const fullLine = (part: RenderChildren | null) =>
      part ? (
        <Box width="100%" flexWrap="nowrap">
          {part}
        </Box>
      ) : null

    // wt: the worktrees made by hand, each by its branch. Subagents' worktrees are left out: their agents are on
    // the ag row.
    const ownTrees = trees.filter(w => !w.agent)
    const treePiece = (w: Worktree, max: number): Piece => ({
      key: w.path,
      parts: [{ text: truncate(w.name, max), color: w.name === mainBranch ? 'green' : 'cyan' }],
    })
    const wtLayouts: Piece[][] =
      ownTrees.length === 0
        ? []
        : [
            ownTrees.map(w => treePiece(w, Infinity)),
            ownTrees.map(w => treePiece(w, 24)),
            ownTrees.map(w => treePiece(w, 12)),
            ...firstAndRest(
              ownTrees.map(w => treePiece(w, 12)),
              hidden => ({ key: 'more', parts: [{ text: `+${hidden.length}`, color: 'cyan' }] }),
            ),
            [countPiece(ownTrees.length, 'cyan')],
          ]
    const wtLine = wtLayouts.length === 0 ? null : fullLine(listPart('wt', wtLayouts))

    // ag: the subagents, and the background runs of another provider's agent (ChatGPT Sol through Codex), each
    // with its description, model and effort, a mark for where it stands, and how long it has run.
    type Act = { key: string; label: string; model?: string; status: keyof typeof AGENT_MARKS; ms: number }
    const acts: Act[] = [
      ...subagents.map(a => ({
        key: a.id,
        label: a.description,
        model: a.model,
        status: a.status,
        ms: (a.endedAt ?? t) - a.firstSeen,
      })),
      ...bg.filter(b => b.model).map(b => ({ key: b.id, label: b.label, model: b.model, status: 'running' as const, ms: t - b.startedAt })),
    ]
    const markPart = (status: keyof typeof AGENT_MARKS): Part => ({
      text: AGENT_MARKS[status].mark,
      color: AGENT_MARKS[status].color,
      dim: AGENT_MARKS[status].color === undefined,
    })
    const worstOf = (list: Act[]) =>
      list.reduce<keyof typeof AGENT_MARKS>((w, a) => (AGENT_MARKS[a.status].rank > AGENT_MARKS[w].rank ? a.status : w), 'completed')
    const actPiece = (a: Act, max: number | null): Piece => ({
      key: a.key,
      parts: [
        ...(max === null ? [] : [{ text: truncate(a.label, max) }]),
        ...(a.model ? [{ text: a.model, color: MODEL_COLOR }] : []),
        markPart(a.status),
        { text: span(a.ms), dim: true },
      ],
    })
    // Grouped by model when the entries no longer fit: `Opus High ×2 ●`.
    const byModel = new Map<string, Act[]>()
    for (const a of acts) byModel.set(a.model ?? 'agent', [...(byModel.get(a.model ?? 'agent') ?? []), a])
    const agLine =
      acts.length === 0
        ? null
        : fullLine(
            listPart('ag', [
              acts.map(a => actPiece(a, Infinity)),
              acts.map(a => actPiece(a, 24)),
              acts.map(a => actPiece(a, 12)),
              acts.map(a => actPiece(a, null)),
              [...byModel].map(([model, list]) => ({
                key: `m:${model}`,
                parts: [{ text: `${model} ×${list.length}`, color: MODEL_COLOR }, markPart(worstOf(list))],
              })),
              [countPiece(acts.length, undefined, markPart(worstOf(acts)))],
            ]),
          )

    // bg: background shells and monitors, by the description their call gave, with how long each has run.
    const plain = bg.filter(b => !b.model)
    const taskPiece = (b: BgTask, max: number): Piece => ({
      key: b.id,
      parts: [
        { text: truncate(b.label, max), color: 'magenta' },
        { text: span(t - b.startedAt), dim: true },
      ],
    })
    const bgLine =
      plain.length === 0
        ? null
        : fullLine(
            listPart('bg', [
              plain.map(b => taskPiece(b, Infinity)),
              plain.map(b => taskPiece(b, 32)),
              plain.map(b => taskPiece(b, 16)),
              ...firstAndRest(
                plain.map(b => taskPiece(b, 16)),
                hidden => ({ key: 'more', parts: [{ text: `+${hidden.length}`, color: 'magenta' }] }),
              ),
              [countPiece(plain.length, 'magenta', { text: span(t - Math.min(...plain.map(b => b.startedAt))), dim: true })],
            ]),
          )

    // Row 2: the branch with its diff against the main branch beside it (`+152 −32`, uncommitted work included),
    // the milestone in the middle, and the session time on the right. When the row runs out of room the
    // milestone's headline is cut, then left out, then its bar, then the milestone, then the diff.
    const elapsed = started !== null ? fmtElapsed(t - started) : null
    const diffShown = workOn && diffState?.kind === 'ok' && !diffState.clean
    const diffNumbers = diffState?.kind === 'ok' ? [`+${diffState.added}`, `−${diffState.deleted}`] : []
    const branchText = onBranch ? `⎇ ${onBranch}` : ''
    // The branch, and with the diff two columns and the two numbers a column apart; `time 26m`. With the
    // milestone in the middle both sides take the wider one's columns, so the middle sits at the true centre: two
    // sides, a column either side of the middle, and the milestone.
    const leftWidth = (diff: boolean): Width => ({
      text: cells(branchText) + (diff ? diffNumbers.reduce((w, x) => w + cells(x), 0) : 0),
      gaps: diff ? 1 + (onBranch ? 2 : 0) : 0,
    })
    const rightWidth: Width = { text: elapsed ? 4 + cells(elapsed) : 0, gaps: elapsed ? 1 : 0 }
    const columns = (w: Width) => Math.ceil(w.text * scale) + w.gaps
    const sideColumns = (diff: boolean) => Math.max(columns(leftWidth(diff)), columns(rightWidth))
    // ms: the milestone being worked on, its title, a bar of its issues closed, the count and the headline of its
    // description (`0.2.0 ██░░░░ 3/22 Agent rules and the merge loop`). Clicking the title opens it on GitHub.
    const ms = workOn && prState?.kind === 'ok' ? (prState.milestone ?? null) : null
    const msStale = prState?.kind === 'ok' && prState.stale
    const msCount = ms ? `${ms.closed}/${ms.total}` : ''
    const headline = ms?.headline ?? ''
    // How much of the milestone is drawn: with or without its bar, and its headline cut to so many cells (0: none).
    type MsShape = { bar: boolean; headline: number } | null
    const headlineText = (shape: MsShape) => (shape && shape.headline > 0 ? truncate(headline, shape.headline) : '')
    const msWidth = (shape: MsShape): Width => {
      if (!ms || !shape) return { text: 0, gaps: 0 }
      const h = headlineText(shape)
      return {
        text: 2 + cells(ms.title) + (shape.bar ? BAR_WIDTH : 0) + cells(msCount) + cells(h),
        gaps: 2 + (shape.bar ? 1 : 0) + (h ? 1 : 0),
      }
    }
    const row2Fits = (diff: boolean, shape: MsShape) => {
      if (!(shape && ms)) return columns(leftWidth(diff)) + 1 + columns(rightWidth) <= e.props.bodyColumns
      const mid = msWidth(shape)
      return 2 * sideColumns(diff) + 2 + mid.text * scale + mid.gaps <= e.props.bodyColumns
    }
    const msShapes: MsShape[] = ms
      ? [
          ...(headline ? [Infinity, 32, 16].map(h => ({ bar: true, headline: h })) : []),
          { bar: true, headline: 0 },
          { bar: false, headline: 0 },
        ]
      : []
    const row2Fit = [
      ...msShapes.map(shape => ({ diff: diffShown, ms: shape })),
      { diff: diffShown, ms: null },
      { diff: false, ms: null },
    ].find(c => row2Fits(c.diff, c.ms)) ?? { diff: false, ms: null }
    const msFilled = ms ? filledCells(ms.total === 0 ? 0 : (ms.closed / ms.total) * 100) : 0
    const msPart =
      ms && row2Fit.ms ? (
        <Box flexWrap="nowrap" columnGap={1}>
          <Text bold>ms</Text>
          <Button key="ms" plain onPress={() => openUrl($, ms.url)}>
            <Text color="cyan" dimColor={msStale}>
              {ms.title}
            </Text>
          </Button>
          {row2Fit.ms.bar ? (
            <Box>
              <Text color="cyan" dimColor={msStale}>
                {'█'.repeat(msFilled)}
              </Text>
              <Text color="gray">{'█'.repeat(BAR_WIDTH - msFilled)}</Text>
            </Box>
          ) : null}
          <Text dimColor={msStale}>{msCount}</Text>
          {headlineText(row2Fit.ms) ? <Text dimColor={msStale}>{headlineText(row2Fit.ms)}</Text> : null}
        </Box>
      ) : null
    const diffPart = row2Fit.diff ? (
      <Box flexWrap="nowrap" columnGap={1}>
        <Text color="green">{diffNumbers[0]}</Text>
        <Text color="red">{diffNumbers[1]}</Text>
      </Box>
    ) : null
    const branchPart =
      onBranch || diffPart ? (
        <Box flexWrap="nowrap" columnGap={2}>
          {onBranch ? (
            <Text color={onBranch === mainBranch ? 'green' : 'yellow'} bold={onBranch !== mainBranch}>
              {branchText}
            </Text>
          ) : null}
          {diffPart}
        </Box>
      ) : null
    const timePart = elapsed ? (
      <Box columnGap={1}>
        <Text bold>time</Text>
        <Text>{elapsed}</Text>
      </Box>
    ) : null
    const side = sideColumns(row2Fit.diff)
    const statusLine = msPart ? (
      <Box width="100%" flexWrap="nowrap" columnGap={1}>
        <Box width={side} flexShrink={0} flexWrap="nowrap">
          {branchPart}
        </Box>
        <Box flexGrow={1} flexWrap="nowrap" justifyContent="center">
          {msPart}
        </Box>
        <Box width={side} flexShrink={0} flexWrap="nowrap" justifyContent="flex-end">
          {timePart}
        </Box>
      </Box>
    ) : branchPart || timePart ? (
      <Box width="100%" flexWrap="nowrap" justifyContent="space-between" columnGap={1}>
        {branchPart ?? <Box />}
        {timePart}
      </Box>
    ) : null

    // pr: the open PRs, each with its checks passed out of the total; drawn only while one is open.
    const prList = workOn && prState?.kind === 'ok' ? prState.prs : []
    const stale = prState?.kind === 'ok' && prState.stale
    const prLabel = (p: Pr, max: number | null) => (max === null || p.title === '' ? `#${p.number}` : `#${p.number} ${truncate(p.title, max)}`)
    const checksPart = (state: Checks['state'], text: string): Part => ({
      text,
      color: stale ? undefined : CHECK_MARKS[state].color,
      dim: stale || state === 'unknown',
    })
    // A result's mark and count, then the first failed checks by name (`✗ 3/4 windows +1`), as many as `names`
    // says, each cut to `max`.
    // A state saved before failed names were kept has none, until the next refresh.
    const resultParts = (checks: Checks | null, names: number, max: number): Part[] => {
      const failedNames = checks?.failed ?? []
      return checks
        ? [
            checksPart(
              checks.state,
              checks.total === 0 ? CHECK_MARKS[checks.state].mark : `${CHECK_MARKS[checks.state].mark} ${checks.passed}/${checks.total}`,
            ),
            ...(names > 0 && failedNames.length > 0
              ? [
                  {
                    text:
                      failedNames.slice(0, names).map(n => truncate(n, max)).join(', ') +
                      (failedNames.length > names ? ` +${failedNames.length - names}` : ''),
                    color: stale ? undefined : 'red',
                    dim: stale,
                  },
                ]
              : []),
          ]
        : []
    }
    // A PR in conflict with its base is marked ⚠: its pull_request workflows won't run until that's resolved.
    const conflictPart: Part = { text: '⚠', color: stale ? undefined : 'red', dim: stale }
    const prPiece = (p: Pr, max: number | null, names = 0): Piece => ({
      key: `pr:${p.number}`,
      parts: [
        { text: prLabel(p, max), dim: p.draft || stale, press: () => openUrl($, p.url) },
        ...(p.conflict ? [conflictPart] : []),
        ...resultParts(p.checks, names, 16),
      ],
    })
    const worstCheck = prList.reduce<Checks['state'] | null>(
      (w, p) => (p.checks && (w === null || CHECK_MARKS[p.checks.state].rank > CHECK_MARKS[w].rank) ? p.checks.state : w),
      null,
    )
    const prLayouts = [
      prList.map(p => prPiece(p, Infinity, 2)),
      prList.map(p => prPiece(p, 32, 1)),
      prList.map(p => prPiece(p, 32)),
      prList.map(p => prPiece(p, 16)),
      prList.map(p => prPiece(p, null)),
      [
        countPiece(
          prList.length,
          undefined,
          ...(prList.some(p => p.conflict) ? [conflictPart] : []),
          ...(worstCheck ? [checksPart(worstCheck, CHECK_MARKS[worstCheck].mark)] : []),
        ),
      ],
    ]
    const prLine = prList.length === 0 ? null : fullLine(listPart('pr', prLayouts))

    // ci: the workflow runs a push, a dispatch, a release or a schedule started, each with its jobs passed out of
    // the total and the failed ones by name; a finished one stays for ten minutes.
    const runList = workOn && prState?.kind === 'ok' ? (prState.runs ?? []).filter(r => r.doneAt === undefined || t - r.doneAt < CI_DONE_MS) : []
    const runPiece = (r: CiRun, max: number, names: number): Piece => ({
      key: `ci:${r.id}`,
      parts: [{ text: truncate(r.workflow, max), dim: stale }, ...resultParts(r.checks, names, 16)],
    })
    const worstRun = runList.reduce<Checks['state'] | null>(
      (w, r) => (r.checks && (w === null || CHECK_MARKS[r.checks.state].rank > CHECK_MARKS[w].rank) ? r.checks.state : w),
      null,
    )
    const ciLine =
      runList.length === 0
        ? null
        : fullLine(
            listPart('ci', [
              runList.map(r => runPiece(r, Infinity, 2)),
              runList.map(r => runPiece(r, 24, 1)),
              runList.map(r => runPiece(r, 12, 1)),
              runList.map(r => runPiece(r, 12, 0)),
              [countPiece(runList.length, undefined, ...(worstRun ? [checksPart(worstRun, CHECK_MARKS[worstRun].mark)] : []))],
            ]),
          )

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
                borderColor="gray"
                hover={{ borderColor: 'white' }}
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

    if (!awayLine && !statusLine && !agLine && !bgLine && !wtLine && !prLine && !ciLine && !recentLine) {
      return firstLine
    }

    // A blank line between rows while they all fit in the rows the band may take; packed tight when they don't,
    // so the list rows stay in view instead of scrolling behind the band's `n more`. Each row is one line but
    // the recent-sessions cells, which take three; the blank lines go between rows.
    const shown = [awayLine, statusLine, agLine, bgLine, wtLine, prLine, ciLine, recentLine].filter(Boolean).length + 1
    const height = shown + (recentLine && sessions !== null && sessions.length > 0 ? 2 : 0)
    const spacing = height + shown - 1 <= e.props.maxRows ? 1 : 0

    return (
      <Box width="100%" flexDirection="column" rowGap={spacing}>
        {firstLine}
        {awayLine}
        {statusLine}
        {agLine}
        {bgLine}
        {wtLine}
        {prLine}
        {ciLine}
        {recentLine}
      </Box>
    )
  })
}

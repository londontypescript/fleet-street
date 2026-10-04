import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Away, BgTask, Context, Limit, Subagent } from '../types'

const limits = atom({ plugin: 'fleet-street', key: 'limits' } as const, [] as Limit[])
const context = atom({ plugin: 'fleet-street', key: 'context' } as const, null as Context | null)
const lastResponseAt = atom({ plugin: 'fleet-street', key: 'lastResponseAt' } as const, null as number | null)
const now = atom({ plugin: 'fleet-street', key: 'now' } as const, 0)
const timerStart = atom({ plugin: 'fleet-street', key: 'timerStart' } as const, null as number | null)
const away = atom({ plugin: 'fleet-street', key: 'away' } as const, null as Away | null)
const subagents = atom({ plugin: 'fleet-street', key: 'subagents' } as const, [] as Subagent[])
// Background shells and monitors (background subagents are on the agents list already).
const bgTasks = atom({ plugin: 'fleet-street', key: 'bgTasks' } as const, [] as BgTask[])
// The session folder's branch, `@<hash>` on a detached HEAD, null outside a git repository.
const branch = atom({ plugin: 'fleet-street', key: 'branch' } as const, null as string | null)

// The session timer's start lives in the store too, keyed by session, so a resume carries on counting.
const timerKey = async ($: EngineInterface) => `timer:${await $.session.id()}`
// When the person last did something (sent a prompt) or the main loop last finished; the away check measures from it.
const activeKey = async ($: EngineInterface) => `active:${await $.session.id()}`

// Prompts that mean the person is at the keyboard (typed here or through Remote Control).
const PERSON_ORIGINS = new Set(['composer', 'bridge'])

// claude-sonnet-5-5 → sonnet 5.5, claude-haiku-4-5-20251001 → haiku 4.5; an alias stays as it is.
const fmtModel = (id: string) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id)
  return m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}


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

// Whole minutes, as 47m or 2h05m.
const fmtElapsed = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// 1st, 2nd, 3rd, 4th … 11th, 12th, 13th, 21st.
const ordinal = (n: number) => {
  const r = n % 100
  if (r >= 11 && r <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

// Sunday 4th October 02:35, in local time.
const fmtClock = (ms: number) => {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${WEEKDAYS[d.getDay()]} ${ordinal(d.getDate())} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`
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

// Module mirrors: the away check and the subagent bookkeeping read them without a state round trip.
let lastActive: number | null = null
let subagentCount = 0

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

async function setSubagents($: EngineInterface, fn: (list: Subagent[]) => Subagent[]) {
  await update($, subagents, list => {
    const next = fn(list)
    subagentCount = next.length
    return next
  })
}

async function pruneSubagents($: EngineInterface) {
  const running = new Set((await $.agent.list()).filter(a => a.status === 'running').map(a => a.id))
  await setSubagents($, list => (list.every(a => running.has(a.id)) ? list : list.filter(a => running.has(a.id))))
}

export const register: Register = (on, options) => {
  const awayMs = Number(options.awayMinutes ?? 30) * 60_000
  const mainBranch = String(options.mainBranch ?? 'main')
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
    subagentCount = (await read($, subagents)).length
    bgCount = (await read($, bgTasks)).length
    await $.command.register({ name: 'reset-timer', description: 'Restart the session timer in the fleet-street banner' })
    void refreshBranch($)
    $.clock.every(1000, () => {
      const t = Date.now()
      // A checkout made outside the session (another terminal) shows within five seconds.
      if (Math.floor(t / 1000) % 5 === 0) void refreshBranch($)
      // A subagent that was stopped may never report its end; drop any the engine no longer runs.
      if (subagentCount > 0 && Math.floor(t / 1000) % 10 === 0) void pruneSubagents($)
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

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if ('agentId' in result && result.agentId) {
      const agent: Subagent = {
        id: result.agentId,
        type: e.subagentType,
        description: e.description,
        model: result.model,
        tokens: 0,
        startedAt: Date.now(),
      }
      await setSubagents($, list => [...list.filter(a => a.id !== agent.id), agent])
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
    const usage = result.usage
    if (e.agentId !== undefined && usage) {
      // What the subagent's conversation holds after this step: the same measure as ctx.
      const tokens =
        usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
      const id = e.agentId
      if (subagentCount > 0) {
        await setSubagents($, list => list.map(a => (a.id === id ? { ...a, tokens, model: usage.model } : a)))
      }
    }
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
    } else if (subagentCount > 0) {
      const id = e.agentId
      await setSubagents($, list => list.filter(a => a.id !== id))
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
    const agents = await read($, subagents)
    const onBranch = await read($, branch)
    const bg = await read($, bgTasks)

    // Spacing comes from Box gaps, not spaces inside Text: the desktop surface trims those.
    const sep = <Text dimColor>│</Text>
    const parts: RenderChildren[] = []

    for (const l of ls) {
      const reset = l.resetsAt ? fmtDuration(Date.parse(l.resetsAt) - t) : null
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

    // One entry per subagent (model and tokens); when that would overflow the line, one per model with a count.
    const perAgent = agents.map(a => ({
      key: a.id,
      model: fmtModel(a.model),
      count: 1,
      tokens: a.tokens,
      startedAt: a.startedAt ?? t,
    }))
    // Under a minute reads <1m, so the banner keeps its once-a-minute redraw.
    const age = (startedAt: number) => (t - startedAt < 60_000 ? '<1m' : fmtElapsed(t - startedAt))
    const widthOf = (list: typeof perAgent) =>
      7 + list.reduce((w, x) => w + x.model.length + fmtTokens(x.tokens).length + age(x.startedAt).length + (x.count > 1 ? 4 : 0) + 5, 0)
    let entries = perAgent
    const bgWidth = bg.length === 0 ? 0 : 5 + bg.reduce((w, b) => w + b.label.length + age(b.startedAt).length + 4, 0)
    // The second line's outer columns share one width, so the middle one sits at the true centre.
    const elapsed = started !== null ? fmtElapsed(t - started) : null
    const sideWidth = Math.max(onBranch ? onBranch.length + 3 : 0, elapsed ? elapsed.length + 5 : 0)
    const fixedWidth = 2 * sideWidth + bgWidth + 2
    if (widthOf(perAgent) + fixedWidth > e.props.bodyColumns) {
      const byModel = new Map<string, (typeof perAgent)[number]>()
      for (const x of perAgent) {
        const g = byModel.get(x.model)
        byModel.set(
          x.model,
          g
            ? { ...g, count: g.count + 1, tokens: g.tokens + x.tokens, startedAt: Math.min(g.startedAt, x.startedAt) }
            : { ...x, key: x.model },
        )
      }
      entries = [...byModel.values()]
    }

    const branchPart = onBranch ? (
      <Text color={onBranch === mainBranch ? 'green' : 'yellow'} bold={onBranch !== mainBranch}>
        ⎇ {onBranch}
      </Text>
    ) : null

    const agentPart =
      entries.length > 0 ? (
        <Box flexWrap="nowrap" columnGap={1}>
          <Text bold>agents</Text>
          {entries.flatMap((x, i) => {
            const row = (
              <Box key={x.key} columnGap={1}>
                <Text color="cyan">
                  {x.model}
                  {x.count > 1 ? ` ×${x.count}` : ''}
                </Text>
                <Text>{x.tokens > 0 ? fmtTokens(x.tokens) : '…'}</Text>
                <Text dimColor>{age(x.startedAt)}</Text>
              </Box>
            )
            return i === 0 ? [row] : [sep, row]
          })}
        </Box>
      ) : null

    // Each task by its command; collapsed to a count and the oldest's age when the line has no room.
    const bgCollapsed = 2 * sideWidth + 2 + widthOf(entries) + bgWidth > e.props.bodyColumns
    const bgPart =
      bg.length === 0 ? null : (
        <Box flexWrap="nowrap" columnGap={1}>
          <Text bold>bg</Text>
          {bgCollapsed ? (
            <Box columnGap={1}>
              <Text color="magenta">×{bg.length}</Text>
              <Text dimColor>{age(Math.min(...bg.map(b => b.startedAt)))}</Text>
            </Box>
          ) : (
            bg.flatMap((b, i) => {
              const row = (
                <Box key={b.id} columnGap={1}>
                  <Text color="magenta">{b.label}</Text>
                  <Text dimColor>{age(b.startedAt)}</Text>
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

    // Branch on the left, agents and background tasks in the middle, session time on the right.
    const middleParts = [agentPart, bgPart].filter(p => p !== null)
    // With no agents or background tasks the middle shows the date and time, if it fits between the sides.
    const clockText = middleParts.length === 0 && t > 0 ? fmtClock(t) : null
    // A small faint dot sits in the middle of the space on each side of the clock: the two outer boxes
    // share what is left equally and centre their dot. Dots are one character, so nothing can overflow.
    const clockPart =
      clockText !== null && 2 * sideWidth + 2 + clockText.length + 4 <= e.props.bodyColumns ? (
        <Box width="100%" flexWrap="nowrap">
          <Box flexGrow={1} flexShrink={1} justifyContent="center">
            <Text dimColor>•</Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor>{clockText}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} justifyContent="center">
            <Text dimColor>•</Text>
          </Box>
        </Box>
      ) : clockText !== null && 2 * sideWidth + 2 + clockText.length <= e.props.bodyColumns ? (
        <Text dimColor>{clockText}</Text>
      ) : null
    if (clockPart) middleParts.push(clockPart)
    const agentLine =
      branchPart || timePart || middleParts.length > 0 ? (
        <Box width="100%" flexWrap="nowrap" columnGap={1}>
          <Box width={sideWidth} flexShrink={0}>
            {branchPart}
          </Box>
          <Box flexGrow={1} justifyContent="center" columnGap={1}>
            {middleParts.flatMap((p, i) => (i === 0 ? [p] : [sep, p]))}
          </Box>
          <Box width={sideWidth} flexShrink={0} justifyContent="flex-end">
            {timePart}
          </Box>
        </Box>
      ) : null

    if (!awayLine && !agentLine) {
      return firstLine
    }

    return (
      <Box width="100%" flexDirection="column" rowGap={1}>
        {firstLine}
        {awayLine}
        {agentLine}
      </Box>
    )
  })
}

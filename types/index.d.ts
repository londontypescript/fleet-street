export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { tokens?: number; window: number; percent?: number }
export type Away = { gapMs: number }
// model: set for a background run of another provider's agent (a ChatGPT Sol review through codex-locked),
// shown with the subagents rather than as a plain task, e.g. 'Sol High'.
export type BgTask = { id: string; label: string; startedAt: number; model?: string }
// A subagent of this session as the agent list reports it, with its model and effort once a step or a tool
// call has shown them (e.g. 'Opus High'); endedAt once it was first seen finished.
export type Subagent = {
  id: string
  description: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  model?: string
  firstSeen: number
  endedAt?: number
}
// agent: a worktree the app made for a subagent (.claude/worktrees/agent-…, branch worktree-agent-…).
// branch: the branch checked out there, null when detached (name is then its folder).
export type Worktree = { path: string; name: string; branch: string | null; agent: boolean }

export type RecentSession = { id: string; title: string; updatedAt: number; link: string }

// A PR's reported checks (or a workflow run's jobs): how many passed out of how many, the worst result among
// them, whether any are still running (a failure outranks them in state, but they still want watching), and
// the names of the failed ones. For a PR the total includes the checks its base branch requires that haven't
// reported (missing); while any are missing and none failed or runs, the state is waiting.
export type Checks = {
  passed: number
  total: number
  state: 'fail' | 'running' | 'waiting' | 'pass' | 'unknown'
  running: boolean
  failed: string[]
  missing?: number
}
// conflict: GitHub says it can't merge into its base, so the workflows a pull_request event starts don't run.
export type Pr = {
  number: number
  title: string
  url: string
  branch: string
  draft: boolean
  conflict?: boolean
  checks: Checks | null
}
// A workflow run that isn't a PR's (a push, a dispatch, a release, a schedule), with its jobs as checks;
// doneAt once it has finished.
export type CiRun = { id: number; workflow: string; url: string; checks: Checks | null; doneAt?: number }
// The milestone being worked on, with its issues closed and in all, and the headline of its description.
export type Milestone = { title: string; url: string; closed: number; total: number; headline?: string }
// loading: before the first answer; ok: the lists, stale once a later refresh failed; unavailable: gh can't answer.
export type PrState =
  | { kind: 'loading' }
  | { kind: 'ok'; prs: Pr[]; runs: CiRun[]; milestone: Milestone | null; stale: boolean }
  | { kind: 'unavailable'; reason: string }
// The branch's lines added and deleted against the main branch, uncommitted work included.
export type DiffState = { kind: 'ok'; added: number; deleted: number; clean: boolean } | { kind: 'unavailable' }

declare module 'claude-code' {
  interface PluginState {
    'fleet-street': {
      limits: Limit[]
      context: Context | null
      lastResponseAt: number | null
      now: number
      timerStart: number | null
      away: Away | null
      worktrees: Worktree[]
      branch: string | null
      bgTasks: BgTask[]
      agents: Subagent[]
      recent: RecentSession[] | null
      sessionsShown: boolean | null
      prs: PrState | null
      diff: DiffState | null
    }
  }
}

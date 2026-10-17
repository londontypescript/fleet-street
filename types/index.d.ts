export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { tokens?: number; window: number; percent?: number }
export type Away = { gapMs: number }
export type BgTask = { id: string; label: string; startedAt: number }
// agent: a worktree the app made for a subagent (.claude/worktrees/agent-…, branch worktree-agent-…).
// branch: the branch checked out there, null when detached (name is then its folder).
export type Worktree = { path: string; name: string; branch: string | null; agent: boolean }

export type RecentSession = { id: string; title: string; updatedAt: number; link: string }

// A PR's reported checks: how many passed out of how many, and the worst result among them.
export type Checks = { passed: number; total: number; state: 'fail' | 'running' | 'pass' | 'unknown' }
export type Pr = { number: number; title: string; url: string; branch: string; draft: boolean; checks: Checks | null }
// loading: before the first answer; ok: the list, stale once a later refresh failed; unavailable: gh can't answer.
export type PrState = { kind: 'loading' } | { kind: 'ok'; prs: Pr[]; stale: boolean } | { kind: 'unavailable'; reason: string }
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
      recent: RecentSession[] | null
      sessionsShown: boolean | null
      prs: PrState | null
      diff: DiffState | null
    }
  }
}

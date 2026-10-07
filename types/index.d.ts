export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { tokens?: number; window: number; percent?: number }
export type Away = { gapMs: number }
export type BgTask = { id: string; label: string; startedAt: number }
// agent: a worktree the app made for a subagent (.claude/worktrees/agent-…, branch worktree-agent-…).
export type Worktree = { path: string; name: string; agent: boolean }

export type RecentSession = { id: string; title: string; updatedAt: number; link: string }

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
    }
  }
}

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Context = { tokens?: number; window: number; percent?: number }
export type Away = { gapMs: number }
export type BgTask = { id: string; label: string; startedAt: number }
export type Subagent = { id: string; type: string; description: string; model: string; tokens: number; startedAt?: number }

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
      subagents: Subagent[]
      branch: string | null
      bgTasks: BgTask[]
      recent: RecentSession[] | null
      sessionsShown: boolean | null
    }
  }
}

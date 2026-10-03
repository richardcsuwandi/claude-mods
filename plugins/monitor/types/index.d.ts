export type JobState = 'running' | 'done' | 'failed' | 'stopped'
export type Job = {
  id: string // the tool_use_id of the call that started it
  taskId?: string // the id the task notification names
  name: string
  kind: 'agent' | 'shell'
  startedAt: number
  endedAt?: number
  state: JobState
}
export type Ctx = { percent: number; tokens?: number; window: number }
export type Block = { tool: string; reason: string }

declare module 'claude-code' {
  interface PluginState {
    monitor: { jobs: Job[]; ctx: Ctx | null; blocked: Block[]; isPinned: boolean; tick: number }
  }
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Block, Ctx, Job } from '../types'

const jobs = atom({ plugin: 'monitor', key: 'jobs' } as const, [] as Job[])
const ctx = atom({ plugin: 'monitor', key: 'ctx' } as const, null as Ctx | null)
const blocked = atom({ plugin: 'monitor', key: 'blocked' } as const, [] as Block[])
const isPinned = atom({ plugin: 'monitor', key: 'isPinned' } as const, false)
const tick = atom({ plugin: 'monitor', key: 'tick' } as const, 0)

const NUDGE_AT = 85
const WIDTH = 10
const COLORS = { running: '#6cb6ff', done: '#8fd694', failed: '#f2777a', stopped: '#f5c06b' }

const hue = (p: number) => (p >= 90 ? COLORS.failed : p >= 70 ? COLORS.stopped : COLORS.done)
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${n}`)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

const field = (text: string, tag: string) => text.match(new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`))?.[1]

async function refreshCtx($: EngineInterface) {
  const { context } = await $.session.usage()
  if (context.percent === undefined) return
  await update($, ctx, () => ({ percent: context.percent ?? 0, tokens: context.tokens, window: context.window }))
}

// Close a job when its task notification arrives (status: completed, failed or killed).
async function settle($: EngineInterface, text: string) {
  const taskId = field(text, 'task-id')
  const toolUseId = field(text, 'tool-use-id')
  const status = field(text, 'status') ?? 'completed'
  const now = await $.clock.now()
  const state = status === 'completed' ? 'done' : status === 'killed' ? 'stopped' : 'failed'
  await update($, jobs, list =>
    list.map(j =>
      j.state === 'running' && ((taskId && j.taskId === taskId) || (toolUseId && j.id === toolUseId))
        ? { ...j, state, endedAt: now }
        : j,
    ),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'monitor', description: 'Pin or unpin the monitor above the prompt (unpinning clears finished jobs)' })
    $.clock.every(1000, async () => {
      if ((await read($, jobs)).some(j => j.state === 'running')) await update($, tick, n => n + 1)
    })
    await refreshCtx($)
    return next(e)
  })

  on('command.run', { command: 'monitor' }, async $ => {
    const now = !(await read($, isPinned))
    await update($, isPinned, () => now)
    if (now) {
      await refreshCtx($)
    } else {
      await update($, jobs, list => list.filter(j => j.state === 'running'))
      await update($, blocked, () => [])
    }
    return { text: now ? 'Monitor pinned.' : 'Monitor unpinned, finished jobs cleared.' }
  })

  on('tool.call', async ($, e, next) => {
    const any = e as any
    const isJob = !any.agentId && (e.tool === 'Agent' || (e.tool === 'Bash' && any.run_in_background === true))
    if (isJob) {
      const now = await $.clock.now()
      const name = (any.description || any.name || any.command || e.tool) as string
      const job: Job = { id: e.tool_use_id, name: clip(name.split('\n')[0], 40), kind: e.tool === 'Agent' ? 'agent' : 'shell', startedAt: now, state: 'running' }
      await update($, jobs, list => [...list, job])
    }

    const ran = await next(e)
    const drop = () => update($, jobs, list => list.filter(j => j.id !== e.tool_use_id))

    if (ran.deny !== undefined) {
      if (isJob) await drop()
      if (!any.agentId) await update($, blocked, list => [...list, { tool: e.tool, reason: clip(ran.deny.split('\n')[0], 120) }].slice(-3))
    } else if (isJob) {
      const result = ran.result as any
      const taskId: string | undefined = e.tool === 'Agent' ? (result?.status === 'async_launched' ? result.agentId : undefined) : result?.backgroundTaskId
      if (ran.isError || !taskId) await drop() // ran in the foreground or never started: not a background job
      else await update($, jobs, list => list.map(j => (j.id === e.tool_use_id ? { ...j, taskId } : j)))
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      await settle($, e.text)
    } else if (e.origin.kind === 'composer') {
      await update($, jobs, list => list.filter(j => j.state === 'running')) // finished jobs stay until your next prompt
      await update($, blocked, () => [])
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refreshCtx($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const list = await read($, jobs)
    const c = await read($, ctx)
    const stops = await read($, blocked)
    const t = await read($, tick)
    const pinned = await read($, isPinned)
    const isFull = (c?.percent ?? 0) >= NUDGE_AT
    if (list.length === 0 && stops.length === 0 && !pinned && !isFull) return next(e)

    const below = await next(e) // other bands stack under this one
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const count = (s: string) => list.filter(j => j.state === s).length
    const nameW = Math.min(28, Math.max(10, ...list.map(j => j.name.length)) + 2)

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Text>
            <Text bold>Monitor</Text>
            {count('running') > 0 && <Text color={COLORS.running}>  {count('running')} running</Text>}
            {count('done') > 0 && <Text color={COLORS.done}>  {count('done')} done</Text>}
            {count('failed') > 0 && <Text color={COLORS.failed}>  {count('failed')} failed</Text>}
            {count('stopped') > 0 && <Text color={COLORS.stopped}>  {count('stopped')} stopped</Text>}
          </Text>
          {list.map(j => {
            const color = COLORS[j.state]
            const icon = j.state === 'running' ? (j.kind === 'agent' ? '🤖' : '⚙️ ') : j.state === 'done' ? '✅' : j.state === 'failed' ? '❌' : '⏹ '
            const pos = (t % (WIDTH + 3)) - 2 // a short bright run sweeps along the bar: activity, not progress
            return (
              <Box key={j.id}>
                <Text>{icon} </Text>
                <Box width={nameW}>
                  <Text bold={j.state !== 'done'} dimColor={j.state === 'done'} color={color} wrap="truncate-end">{j.name}</Text>
                </Box>
                {j.state === 'running' ? (
                  <Text>
                    {Array.from({ length: WIDTH }, (_, i) => (
                      <Text key={i} color={i >= pos && i < pos + 3 ? color : undefined} dimColor={!(i >= pos && i < pos + 3)}>{i >= pos && i < pos + 3 ? '▰' : '▱'}</Text>
                    ))}
                    <Text dimColor> {elapsed(now - j.startedAt)}</Text>
                  </Text>
                ) : (
                  <Text color={color} dimColor={j.state === 'done'}>
                    {/* no duration here: the notification arrives when Claude is free, not when the job ended */}
                    {j.state === 'done' ? 'done' : j.state === 'failed' ? 'failed  needs you' : 'stopped'}
                  </Text>
                )}
              </Box>
            )
          })}
          {stops.map((b, i) => (
            <Text key={i} color={COLORS.stopped} wrap="truncate-end">🚫 {b.tool} blocked: {b.reason}</Text>
          ))}
          {c && (
            <Box>
              <Text>🧠 </Text>
              <Box width={nameW}><Text dimColor>context</Text></Box>
              <Text>
                <Text color={hue(c.percent)}>{'█'.repeat(Math.min(WIDTH, Math.round((c.percent / 100) * WIDTH)))}</Text>
                <Text dimColor>{'░'.repeat(WIDTH - Math.min(WIDTH, Math.round((c.percent / 100) * WIDTH)))}</Text>
                <Text color={hue(c.percent)}> {Math.round(c.percent)}%</Text>
                {c.tokens !== undefined && <Text dimColor> {k(c.tokens)}/{k(c.window)}</Text>}
                {c.percent >= NUDGE_AT && <Text color={COLORS.stopped}>  compact</Text>}
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}

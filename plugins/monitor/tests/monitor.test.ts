import { expect, mock, test } from 'claude-code/testing'

// The session's named values, in memory so a test can read what the plugin wrote.
const values = new Map<string, { value: unknown; version: number }>()
const get = (key: string) => (values.get(key)?.value ?? undefined) as any

// What sits beneath the plugin: the tool core (answering as Claude Code would) and the session.
function world(on: any, toolAnswer: (e: any) => any, context = { window: 200000, tokens: 80000, percent: 40 }) {
  values.clear()
  on('state.get', (_$: any, e: any) => ({ value: { value: values.get(e.key)?.value, version: values.get(e.key)?.version ?? 0 } }))
  on('state.set', (_$: any, e: any) => {
    const version = (values.get(e.key)?.version ?? 0) + 1
    values.set(e.key, { value: e.value, version })
    return { value: { isSet: true, version } }
  })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  mock.clock(on, { now: 1_790_000_000_000 })
  on('tool.call', (_$: any, e: any) => toolAnswer(e))
  on('command.register', () => ({ value: { command: 'monitor' } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.usage', () => ({ value: { startedAt: 0, context, rateLimits: [] } }))
  on('ui.render', () => (h as any)('Box', null)) // what the engine draws beneath: nothing
}

const BG_SHELL = { tool: 'Bash', tool_use_id: 'toolu_1', command: 'npm test', description: 'run unit tests', run_in_background: true }
const notify = (id: string, status: string) => ({
  text: `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>x</summary></task-notification>`,
  origin: { kind: 'task-notification' },
  wait: false,
})
const jobs = async (_$: any) => (get('jobs') ?? []) as { name: string; state: string; taskId?: string }[]

test('a background shell becomes a running job, and its notification marks it done', async ($, on) => {
  world(on, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: '' }))
  await $.session.start({ source: 'startup', cwd: '/work' })
  await $.tool.call(BG_SHELL)
  expect(await jobs($)).toMatchObject([{ name: 'run unit tests', state: 'running', taskId: 'b1' }])

  await $.prompt.submit(notify('b1', 'completed'))
  expect(await jobs($)).toMatchObject([{ state: 'done' }])
})

test('failed and killed notifications mark failed and stopped', async ($, on) => {
  let n = 0
  world(on, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `b${++n}` }, text: '' }))
  await $.session.start({ source: 'startup', cwd: '/work' })
  await $.tool.call({ ...BG_SHELL, tool_use_id: 't1', description: 'one' })
  await $.tool.call({ ...BG_SHELL, tool_use_id: 't2', description: 'two' })
  await $.prompt.submit(notify('b1', 'failed'))
  await $.prompt.submit(notify('b2', 'killed'))
  expect((await jobs($)).map(j => j.state)).toEqual(['failed', 'stopped'])
})

test('a foreground shell is not a job', async ($, on) => {
  world(on, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' }))
  await $.session.start({ source: 'startup', cwd: '/work' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_2', command: 'ls' })
  await $.tool.call({ ...BG_SHELL, run_in_background: false })
  expect(await jobs($)).toEqual([])
})

test('an agent that launched async is a job, one that completed in the foreground is not', async ($, on) => {
  world(on, e => ({ result: e.prompt === 'bg' ? { status: 'async_launched', agentId: 'a1', description: 'd' } : { status: 'completed' }, text: '' }))
  await $.session.start({ source: 'startup', cwd: '/work' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'ag1', description: 'research parsers', prompt: 'bg' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'ag2', description: 'quick look', prompt: 'fg' })
  expect(await jobs($)).toMatchObject([{ name: 'research parsers', kind: 'agent', state: 'running', taskId: 'a1' }])
  await $.prompt.submit(notify('a1', 'completed'))
  expect(await jobs($)).toMatchObject([{ state: 'done' }])
})

test('your next prompt clears finished jobs but keeps running ones', async ($, on) => {
  let n = 0
  world(on, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `b${++n}` }, text: '' }))
  await $.session.start({ source: 'startup', cwd: '/work' })
  await $.tool.call({ ...BG_SHELL, tool_use_id: 't1', description: 'one' })
  await $.tool.call({ ...BG_SHELL, tool_use_id: 't2', description: 'two' })
  await $.prompt.submit(notify('b1', 'completed'))
  await $.prompt.submit({ text: 'next thing', origin: { kind: 'composer' }, wait: false })
  expect((await jobs($)).map(j => j.name)).toEqual(['two'])
})

test('a refused tool call is shown as blocked and is not a job', async ($, on) => {
  world(on, () => ({ deny: 'no-prod-writes: touching production config needs a human' }))
  await $.session.start({ source: 'startup', cwd: '/work' })
  await $.tool.call(BG_SHELL)
  expect(await jobs($)).toEqual([])
  expect((get('blocked') as { reason: string }[])[0].reason).toContain('no-prod-writes')
})

// ---- what is drawn ----
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 90 } } as const

async function band($: any, surface: 'terminal' | 'desktop') {
  return $.ui.mount({ plugin: 'monitor', surface, ...BAND })
}

test('idle and unpinned: the monitor draws nothing', async ($, on) => {
  world(on, () => ({ result: {}, text: '' }))
  await $.session.start({ source: 'startup', cwd: '/work' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: /Monitor/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('a running job and a failed one are drawn, with the counts and "needs you"', async ($, on) => {
  let n = 0
  world(on, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: `b${++n}` }, text: '' }))
  await $.session.start({ source: 'startup', cwd: '/work' })
  await $.tool.call({ ...BG_SHELL, tool_use_id: 't1', description: 'run unit tests' })
  await $.tool.call({ ...BG_SHELL, tool_use_id: 't2', description: 'deploy preview' })
  await $.prompt.submit(notify('b2', 'failed'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: /Monitor/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 failed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /run unit tests/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /needs you/ })).toBeDefined()
    await ui.unmount()
  }
})

test('/monitor pins the band with a context row, and unpinning clears finished jobs', async ($, on) => {
  world(on, () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' }, text: '' }))
  on('command.run', () => ({ text: '' }))
  await $.session.start({ source: 'startup', cwd: '/work' })
  await $.command.run({ command: 'monitor', args: '' })
  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /context/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /40%/ })).toBeDefined()
  await ui.unmount()

  await $.tool.call(BG_SHELL)
  await $.prompt.submit(notify('b1', 'completed'))
  await $.command.run({ command: 'monitor', args: '' }) // unpin
  expect(await jobs($)).toEqual([])
})

test('a full context window shows itself without being pinned and says compact', async ($, on) => {
  world(on, () => ({ result: {}, text: '' }), { window: 200000, tokens: 180000, percent: 90 })
  await $.session.start({ source: 'startup', cwd: '/work' })
  const ui = await band($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /compact/ })).toBeDefined()
  await ui.unmount()
})

import { expect, mock, test } from 'claude-code/testing'

const KEY = 'deadlines'
const LIST = [
  { name: 'AISTATS', at: 1791374340000 },
  { name: 'ICLR rebuttal', at: 1795089540000 },
]
const MIRROR = '/home/me/.claude/deadlines-backup.json'
const THESIS = 'add Thesis 2027-01-01 12:00'

// The world beneath the plugin: an in-memory store (inspectable), filesystem and `date`.
function world(on: any, opts: { store?: Record<string, unknown>; files?: Record<string, string>; fs?: boolean } = {}) {
  const store: Record<string, unknown> = { ...opts.store }
  const files: Record<string, string> = { ...opts.files }
  mock.clock(on, { now: 1790000000000 })
  mock.env(on, opts.fs === false ? {} : { HOME: '/home/me' })
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('fs.read', (_$: any, e: any) => (e.path in files ? { value: files[e.path] } : { deny: 'ENOENT' }))
  on('fs.write', (_$: any, e: any) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '+0800 CST\n', stderr: '' } }))
  on('command.register', () => ({ value: { command: 'ddl' } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return { store, files }
}

const start = ($: any) => $.session.start({ source: 'startup', cwd: '/work' })
const ddl = ($: any, args = '') => $.command.run({ command: 'ddl', args })
const names = (v: unknown) => (v as { name: string }[]).map(d => d.name)

test('add persists to the store and the mirror, and survives a reload', async ($, on) => {
  const { store, files } = world(on)
  await start($)
  await ddl($, THESIS)
  expect(names(store[KEY])).toEqual(['Thesis'])
  expect(names(JSON.parse(files[MIRROR]))).toEqual(['Thesis'])

  await start($) // reload / new session: module restarts, store stays
  expect((await ddl($)).text).toContain('Thesis')
})

test('an update that leaves the store alone keeps every deadline', async ($, on) => {
  const { store } = world(on, { store: { [KEY]: LIST } })
  await start($)
  const out = (await ddl($)).text
  expect(out).toContain('AISTATS')
  expect(out).toContain('ICLR rebuttal')
  expect(names(store[KEY])).toEqual(['AISTATS', 'ICLR rebuttal'])
})

test('store wiped, mirror intact: restored, and a later add does not lose the old ones', async ($, on) => {
  const { store } = world(on, { files: { [MIRROR]: JSON.stringify(LIST) } })
  await start($)
  expect(names(store[KEY])).toEqual(['AISTATS', 'ICLR rebuttal'])

  await ddl($, THESIS)
  expect(names(store[KEY])).toEqual(['AISTATS', 'ICLR rebuttal', 'Thesis'])
})

test('store holds garbage: kept aside, restored from the mirror, never blindly overwritten', async ($, on) => {
  const { store } = world(on, { store: { [KEY]: { oops: true } }, files: { [MIRROR]: JSON.stringify(LIST) } })
  await start($)
  expect(names(store[KEY])).toEqual(['AISTATS', 'ICLR rebuttal'])
  expect(store['deadlines.corrupt']).toEqual({ oops: true })
})

test('first-ever run: starts empty, add works', async ($, on) => {
  const { store } = world(on)
  await start($)
  await ddl($, THESIS)
  expect(names(store[KEY])).toEqual(['Thesis'])
})

test('existing store without a mirror: the mirror is backfilled at start', async ($, on) => {
  const { files } = world(on, { store: { [KEY]: LIST } })
  await start($)
  expect(names(JSON.parse(files[MIRROR]))).toEqual(['AISTATS', 'ICLR rebuttal'])
})

test('rm removes, and an emptied list is not resurrected from the mirror', async ($, on) => {
  const { store, files } = world(on, { store: { [KEY]: LIST } })
  await start($)
  await ddl($, 'rm AISTATS')
  await ddl($, 'rm ICLR rebuttal')
  expect(store[KEY]).toEqual([])
  expect(JSON.parse(files[MIRROR])).toEqual([])

  await start($)
  expect(store[KEY]).toEqual([])
})

test('no HOME / no filesystem: the store alone still works', async ($, on) => {
  const { store } = world(on, { fs: false })
  await start($)
  await ddl($, THESIS)
  expect(names(store[KEY])).toEqual(['Thesis'])
})

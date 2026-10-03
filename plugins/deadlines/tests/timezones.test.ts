import { expect, mock, test } from 'claude-code/testing'

// Same world as persistence.test.ts: machine in CST (UTC+8).
function world(on: any) {
  const store: Record<string, unknown> = {}
  mock.clock(on, { now: 1790000000000 })
  mock.env(on, {})
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '+0800 CST\n', stderr: '' } }))
  on('command.register', () => ({ value: { command: 'ddl' } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  return store
}
const start = ($: any) => $.session.start({ source: 'startup', cwd: '/work' })
const ddl = ($: any, args: string) => $.command.run({ command: 'ddl', args })
const at = (store: Record<string, unknown>) => (store.deadlines as { at: number }[])[0].at
const utc = (y: number, mo: number, d: number, h: number, m = 0) => Date.UTC(y, mo - 1, d, h, m)

// [typed zone, date, time, expected UTC instant]
const CASES: [string, string, string, number][] = [
  ['aoe', '2026-10-06', '23:59', utc(2026, 10, 7, 11, 59)],
  ['utc', '2026-10-06', '12:00', utc(2026, 10, 6, 12)],
  ['wib', '2026-10-06', '23:59', utc(2026, 10, 6, 16, 59)], // UTC+7
  ['wita', '2026-10-06', '12:00', utc(2026, 10, 6, 4)], // UTC+8
  ['jst', '2026-10-06', '12:00', utc(2026, 10, 6, 3)], // UTC+9
  ['ist', '2026-10-06', '12:00', utc(2026, 10, 6, 6, 30)], // India UTC+5:30
  ['pst', '2027-01-15', '12:00', utc(2027, 1, 15, 20)], // UTC-8
  ['pdt', '2026-07-15', '12:00', utc(2026, 7, 15, 19)], // UTC-7
  ['est', '2027-01-15', '12:00', utc(2027, 1, 15, 17)], // UTC-5
  ['cet', '2027-01-15', '12:00', utc(2027, 1, 15, 11)], // UTC+1
  ['+05:30', '2026-10-06', '12:00', utc(2026, 10, 6, 6, 30)],
  ['utc-5', '2026-10-06', '12:00', utc(2026, 10, 6, 17)],
  ['gmt+7', '2026-10-06', '12:00', utc(2026, 10, 6, 5)],
  ['cst', '2026-10-06', '12:00', utc(2026, 10, 6, 4)], // matches the machine's own label: local, UTC+8
  ['local', '2026-10-06', '12:00', utc(2026, 10, 6, 4)],
  // pt/et pick PST/PDT by the deadline's own date (US DST: Mar 8 2026 to Nov 1 2026)
  ['pt', '2026-07-15', '12:00', utc(2026, 7, 15, 19)],
  ['pt', '2027-01-15', '12:00', utc(2027, 1, 15, 20)],
  ['pt', '2026-03-07', '12:00', utc(2026, 3, 7, 20)], // day before DST starts: PST
  ['pt', '2026-03-08', '12:00', utc(2026, 3, 8, 19)], // DST starts: PDT
  ['pt', '2026-10-31', '12:00', utc(2026, 10, 31, 19)], // still PDT
  ['pt', '2026-11-01', '12:00', utc(2026, 11, 1, 20)], // DST over: PST
  ['et', '2026-07-15', '12:00', utc(2026, 7, 15, 16)],
]

for (const [zone, date, time, want] of CASES) {
  test(`/ddl add ... ${date} ${time} ${zone}`, async ($, on) => {
    const store = world(on)
    await start($)
    await ddl($, `add X ${date} ${time} ${zone}`)
    expect(at(store)).toBe(want)
  })
}

test('no zone: your own local time, as before', async ($, on) => {
  const store = world(on)
  await start($)
  await ddl($, 'add X 2026-10-06 12:00')
  expect(at(store)).toBe(utc(2026, 10, 6, 4))
})

test('zone without a time defaults to 23:59 in that zone', async ($, on) => {
  const store = world(on)
  await start($)
  await ddl($, 'add X 2026-10-06 wib')
  expect(at(store)).toBe(utc(2026, 10, 6, 16, 59))
})

test('names with spaces still work next to a zone', async ($, on) => {
  const store = world(on)
  await start($)
  const out = await ddl($, 'add ICLR rebuttal 2026-11-18 23:59 aoe')
  expect((store.deadlines as { name: string }[])[0].name).toBe('ICLR rebuttal')
  expect(out.text).toContain('Added ICLR rebuttal')
})

test('unknown zone is refused and nothing is saved', async ($, on) => {
  const store = world(on)
  await start($)
  const out = await ddl($, 'add X 2026-10-06 12:00 mars')
  expect(out.text).toContain('Unknown time zone "mars"')
  expect(store.deadlines).toEqual([])
})

test('confirmation shows your local time and what you typed', async ($, on) => {
  world(on)
  await start($)
  const out = await ddl($, 'add X 2026-10-06 23:59 wib')
  expect(out.text).toContain('Oct 7 00:59 CST')
  expect(out.text).toContain('WIB')
  expect(out.text).toContain('UTC+07:00')
})

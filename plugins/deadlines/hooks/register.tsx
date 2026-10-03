import type { EngineInterface, Register } from 'claude-code'

type Deadline = { name: string; at: number } // at: epoch ms

const HOUR = 3_600_000
const SEED: Deadline[] = []
const USAGE = 'Usage: /ddl, /ddl add <name> <YYYY-MM-DD> [HH:MM] [zone], /ddl rm <name>. Zones: aoe utc pst pt est et cet wib jst sgt ist ... or +08:00'

// Fixed UTC offsets in minutes. Daylight-saving zones come as pairs (est/edt), or as et/ct/mt/pt
// which pick the US rule for the deadline's date.
// ponytail: `ist` is India and `cst` US Central unless it matches your machine's own label.
const ZONES: Record<string, number> = {
  aoe: -720, utc: 0, gmt: 0, z: 0,
  hst: -600, akst: -540, akdt: -480, pst: -480, pdt: -420, mst: -420, mdt: -360,
  cst: -360, cdt: -300, est: -300, edt: -240, ast: -240, nst: -210,
  wet: 0, west: 60, bst: 60, cet: 60, cest: 120, eet: 120, eest: 180, msk: 180,
  ist: 330, pkt: 300, npt: 345, ict: 420, wib: 420, wita: 480, wit: 540,
  sgt: 480, hkt: 480, pht: 480, awst: 480, jst: 540, kst: 540, acst: 570,
  aest: 600, aedt: 660, nzst: 720, nzdt: 780,
}
const US_AUTO: Record<string, [number, number]> = { et: [-300, -240], ct: [-360, -300], mt: [-420, -360], pt: [-480, -420] }

// US daylight saving: second Sunday of March to first Sunday of November (the 2am edge is ignored).
function isUsDst(y: number, mo: number, d: number): boolean {
  const sunday = (month: number, nth: number) => {
    const first = new Date(Date.UTC(y, month - 1, 1)).getUTCDay()
    return 1 + ((7 - first) % 7) + 7 * (nth - 1)
  }
  const day = mo * 100 + d
  return day >= 300 + sunday(3, 2) && day < 1100 + sunday(11, 1)
}

// Offset in minutes for a zone word typed after the date, or undefined when it isn't one.
function zoneOffset(word: string, y: number, mo: number, d: number, local: { offset: number; label: string }): number | undefined {
  const w = word.toLowerCase()
  if (w === 'local' || w === local.label.toLowerCase()) return local.offset / 60_000
  if (w in US_AUTO) return US_AUTO[w][isUsDst(y, mo, d) ? 1 : 0]
  if (w in ZONES) return ZONES[w]
  const num = w.match(/^(?:utc|gmt)?([+-])(\d{1,2})(?::?(\d{2}))?$/)
  if (!num) return undefined
  const mins = +num[2] * 60 + +(num[3] ?? 0)
  return num[1] === '-' ? -mins : mins
}

const fmtOffset = (m: number) => `UTC${m < 0 ? '-' : '+'}${String(Math.floor(Math.abs(m) / 60)).padStart(2, '0')}:${String(Math.abs(m) % 60).padStart(2, '0')}`

// The module has no reliable timezone, so ask the host once.
// ponytail: offset read at session start, a DST switch mid-session is off by 1h until restart.
let tz = { offset: 0, label: 'UTC' }

async function readTimezone($: EngineInterface) {
  const { stdout } = await $.process.run(['date', '+%z %Z']).catch(() => ({ stdout: '+0000 UTC' }))
  const [z, label] = stdout.trim().split(' ')
  if (!/^[+-]\d{4}$/.test(z)) return
  const sign = z.startsWith('-') ? -1 : 1
  tz = { offset: sign * (+z.slice(1, 3) * HOUR + +z.slice(3, 5) * 60_000), label: label || z }
}

// Deadlines live in $.store (Claude Code's per-plugin file) and are mirrored to a file of
// our own, so a store that comes back empty (marketplace renamed, file rewritten on update)
// is restored instead of silently overwritten by the next `add`.
const isList = (v: unknown): v is Deadline[] =>
  Array.isArray(v) && v.every(d => d && typeof d.name === 'string' && Number.isFinite(d.at))

async function mirrorPath($: EngineInterface): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/${$.plugin.name}-backup.json` : undefined
}

async function readMirror($: EngineInterface): Promise<Deadline[] | undefined> {
  try {
    const path = await mirrorPath($)
    const parsed = path ? JSON.parse(await $.fs.read(path)) : undefined
    return isList(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

let mirrorChecked = false // only look at the mirror once per load while the store is empty

async function load($: EngineInterface): Promise<Deadline[]> {
  const stored = await $.store.get('deadlines')
  if (isList(stored)) return stored

  if (stored !== undefined) await $.store.set('deadlines.corrupt', stored) // keep it, never overwrite blindly
  if (mirrorChecked) return SEED
  mirrorChecked = true

  const mirror = await readMirror($)
  if (mirror && mirror.length > 0) {
    await $.store.set('deadlines', mirror)
    $.ui.toast(`deadlines: restored ${mirror.length} from backup`)
    return mirror
  }
  return SEED
}

async function save($: EngineInterface, list: Deadline[]) {
  await $.store.set('deadlines', list)
  try {
    const path = await mirrorPath($)
    if (path) await $.fs.write(path, JSON.stringify(list, null, 2))
  } catch {
    // ponytail: mirror is best effort, the store stays the source of truth
  }
}

function left(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h ${m % 60}m`
}

const glyph = (ms: number) => (ms < 86_400_000 ? '●' : ms < 7 * 86_400_000 ? '◐' : '○')
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function local(at: number): string {
  const d = new Date(at + tz.offset)
  const hm = d.toISOString().slice(11, 16)
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hm} ${tz.label}`
}

const DAY = 86_400_000
const tone = (ms: number) => (ms < DAY ? 'error' : ms < 7 * DAY ? 'warning' : 'success')
const mood = (ms: number) => (ms < DAY ? '🔥' : ms < 3 * DAY ? '😬' : ms < 7 * DAY ? '⏳' : ms < 30 * DAY ? '🗓 ' : '🌱')

// Fills up as the deadline nears, over a 30-day window.
function heat(ms: number, width = 16): string {
  const n = Math.round(width * (1 - Math.min(ms, 30 * DAY) / (30 * DAY)))
  return '━'.repeat(n) + '╌'.repeat(width - n)
}

async function refresh($: EngineInterface) {
  const now = await $.clock.now()
  const next = (await load($)).filter(d => d.at > now).sort((a, b) => a.at - b.at)
  if (next.length === 0) return $.ui.status(undefined)
  const [first] = next
  const more = next.length > 1 ? `  +${next.length - 1}` : ''
  $.ui.status(`${glyph(first.at - now)} ${first.name}  ${left(first.at - now)}${more}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await readTimezone($)
    await $.command.register({ name: 'ddl', description: 'Deadlines: list, add <name> <YYYY-MM-DD> [HH:MM] [zone], rm <name>' })
    await save($, await load($)) // restores from the mirror if needed, and backfills the mirror
    $.clock.every(15_000, () => void refresh($))
    await refresh($)
    return next(e)
  })

  on('command.run', { command: 'ddl' }, async ($, e) => {
    const list = await load($)
    const add = e.args.match(/^\s*add\s+(.+?)\s+(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?(?:\s+(\S+))?\s*$/i)
    const rm = e.args.match(/^\s*rm\s+(.+?)\s*$/)

    if (add) {
      const [, name, y, mo, d, hh = '23', mm = '59', zone] = add
      const mins = zone === undefined ? tz.offset / 60_000 : zoneOffset(zone, +y, +mo, +d, tz)
      if (mins === undefined) return { text: `Unknown time zone "${zone}". ${USAGE}` }
      const at = Date.UTC(+y, +mo - 1, +d, +hh, +mm) - mins * 60_000
      await save($, [...list.filter(x => x.name !== name), { name, at }])
      await refresh($)
      const entered = zone === undefined ? '' : ` (${y}-${mo}-${d} ${hh.padStart(2, '0')}:${mm} ${zone.toUpperCase()}, ${fmtOffset(mins)})`
      return { text: `Added ${name}: ${local(at)}${entered}` }
    }
    if (rm) {
      const kept = list.filter(x => x.name.toLowerCase() !== rm[1].toLowerCase())
      await save($, kept)
      await refresh($)
      return { text: kept.length < list.length ? `Removed ${rm[1]}` : `No deadline named ${rm[1]}` }
    }
    if (e.args.trim()) return { text: USAGE }

    const now = await $.clock.now()
    const rows = [...list]
      .sort((a, b) => a.at - b.at)
      .map(d => {
        const state = d.at > now ? `${glyph(d.at - now)} ${left(d.at - now)}` : '✓ passed'
        return `${d.name}: ${local(d.at)}, ${state}`
      })
    return { text: rows.length ? rows.join('\n') : `No deadlines. ${USAGE}` }
  })

  // Draw the bare /ddl list as a card instead of the plain text row.
  on('ui.render', { component: 'CommandOutput', props: { command: 'ddl' } }, async ($, e, next) => {
    if (e.props.args.trim() || e.props.isErrored) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const list = [...(await load($))].sort((a, b) => a.at - b.at)
    const nameWidth = Math.min(24, Math.max(8, ...list.map(d => d.name.length)) + 2)

    return (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Text bold>Deadlines</Text>
        <Text> </Text>
        {list.length === 0 && <Text dimColor>{USAGE}</Text>}
        {list.map(d => {
          const ms = d.at - now
          if (ms <= 0) {
            return (
              <Box key={d.name}>
                <Text dimColor>✅ </Text>
                <Box width={nameWidth}><Text dimColor strikethrough>{d.name}</Text></Box>
                <Text dimColor>done  {local(d.at)}</Text>
              </Box>
            )
          }
          return (
            <Box key={d.name}>
              <Text>{mood(ms)} </Text>
              <Box width={nameWidth}><Text bold color={tone(ms)} wrap="truncate-end">{d.name}</Text></Box>
              <Box width={14}><Text bold>{left(ms)}</Text></Box>
              <Text color={tone(ms)}>{heat(ms)}</Text>
              <Text dimColor>  {local(d.at)}</Text>
            </Box>
          )
        })}
      </Box>
    )
  })
}

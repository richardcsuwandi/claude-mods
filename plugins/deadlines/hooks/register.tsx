import type { EngineInterface, Register } from 'claude-code'

type Deadline = { name: string; at: number } // at: epoch ms

const HOUR = 3_600_000
const AOE = -12 * HOUR // Anywhere on Earth = UTC-12
const SEED: Deadline[] = []
const USAGE = 'Usage: /ddl, /ddl add <name> <YYYY-MM-DD> [HH:MM] [aoe], /ddl rm <name>'

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

async function load($: EngineInterface): Promise<Deadline[]> {
  return ((await $.store.get('deadlines')) as Deadline[] | undefined) ?? SEED
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
    await $.command.register({ name: 'ddl', description: 'Deadlines: list, add <name> <YYYY-MM-DD> [HH:MM] [aoe], rm <name>' })
    $.clock.every(15_000, () => void refresh($))
    await refresh($)
    return next(e)
  })

  on('command.run', { command: 'ddl' }, async ($, e) => {
    const list = await load($)
    const add = e.args.match(/^\s*add\s+(.+?)\s+(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?(\s+aoe)?\s*$/i)
    const rm = e.args.match(/^\s*rm\s+(.+?)\s*$/)

    if (add) {
      const [, name, y, mo, d, hh = '23', mm = '59', aoe] = add
      const at = Date.UTC(+y, +mo - 1, +d, +hh, +mm) - (aoe ? AOE : tz.offset)
      await $.store.set('deadlines', [...list.filter(x => x.name !== name), { name, at }])
      await refresh($)
      return { text: `Added ${name}: ${local(at)}` }
    }
    if (rm) {
      const kept = list.filter(x => x.name.toLowerCase() !== rm[1].toLowerCase())
      await $.store.set('deadlines', kept)
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

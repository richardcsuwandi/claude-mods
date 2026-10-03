import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snap } from '../types'

const NUDGE_AT = 85
const isOn = atom({ plugin: 'usage-bar', key: 'isOn' } as const, true)
const snap = atom({ plugin: 'usage-bar', key: 'snap' } as const, null)
const isNudged = atom({ plugin: 'usage-bar', key: 'isNudged' } as const, false)

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

async function refresh($: any) {
  const { context, rateLimits, cost } = await $.session.usage()
  const next: Snap = {
    bars: [
      { label: 'ctx', percent: context.percent ?? 0 },
      ...rateLimits.map((r: any) => ({ label: LABELS[r.kind] ?? r.kind, percent: r.percentUsed })),
    ],
    usd: cost ? cost.usd : null,
  }
  await update($, snap, () => next)

  const ctx = next.bars[0].percent
  if (ctx >= NUDGE_AT && !(await read($, isNudged))) {
    await update($, isNudged, () => true)
    $.ui.toast(`Context ${Math.round(ctx)}% full. Run /compact (or press Compact above the prompt).`)
  } else if (ctx < NUDGE_AT - 10) {
    await update($, isNudged, () => false) // re-arm after a compact
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'usage-bar', description: 'Toggle the usage bars above the prompt' })
    return next(e)
  })

  on('command.run', { command: 'usage-bar' }, async $ => {
    const now = !(await read($, isOn))
    await update($, isOn, () => now)
    if (now) await refresh($)
    return { text: `Usage bar ${now ? 'on' : 'off'}.` }
  })

  // nudge runs even with the bar hidden
  on('turn.complete', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (!(await read($, isOn)) || !s || e.props.hasSurvey) return next(e)
    const below = await next(e) // other bands stack under this row

    const { Box, Text, Button } = $.ui.resolve(e)
    const hue = (p: number) => (p >= 90 ? 'red' : p >= 70 ? 'yellow' : 'green')
    const W = 10

    return (
      <Box flexDirection="column">
        {below}
        <Box>
          {s.bars.map(b => {
            const n = Math.min(W, Math.round((b.percent / 100) * W))
            return (
              <Box key={b.label}>
                <Text dimColor>{b.label} </Text>
                <Text color={hue(b.percent)}>{'█'.repeat(n)}</Text>
                <Text dimColor>{'░'.repeat(W - n)} </Text>
                <Text color={hue(b.percent)}>{Math.round(b.percent)}%  </Text>
              </Box>
            )
          })}
          {s.usd !== null && <Text dimColor>${s.usd.toFixed(2)} </Text>}
          {s.bars[0].percent >= NUDGE_AT && (
            <Button key="compact" label="Compact" onPress={() => $.session.compact()} />
          )}
        </Box>
      </Box>
    )
  })
}

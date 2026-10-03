import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snap } from '../types'

const isOn = atom({ plugin: 'context-bar', key: 'isOn' } as const, false)
const snap = atom({ plugin: 'context-bar', key: 'snap' } as const, null)

// summary = local estimates, no token-count API calls
async function refresh($: any) {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const b = context.breakdown
  if (!b) return
  const next: Snap = {
    segs: b.categories
      .filter((c: any) => c.kind !== 'deferred' && c.tokens > 0)
      .map((c: any) => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
    max: b.rawMaxTokens,
    percent: b.percentage,
  }
  await update($, snap, () => next)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'context-bar', description: 'Toggle the context window bar above the prompt' })
    return next(e)
  })

  on('command.run', { command: 'context-bar' }, async $ => {
    const now = !(await read($, isOn))
    await update($, isOn, () => now)
    if (now) await refresh($)
    return { text: `Context bar ${now ? 'on' : 'off'}.` }
  })

  on('turn.complete', async ($, e, next) => {
    if (await read($, isOn)) await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, snap)
    if (!(await read($, isOn)) || !s) return next(e)
    const below = await next(e) // other bands stack under this one

    const { Box, Text } = $.ui.resolve(e)
    const width = Math.max(20, (e.viewport?.columns ?? 80) - 4)
    const total = s.segs.reduce((n, c) => n + c.tokens, 0) || 1
    // largest-remainder-free rounding: cumulative edges keep the bar exactly `width` wide
    let acc = 0
    const cells = s.segs.map(c => {
      const from = Math.round((acc / total) * width)
      acc += c.tokens
      return { ...c, n: Math.round((acc / total) * width) - from }
    })
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

    return (
      <Box flexDirection="column">
        {below}
        <Box>
          {cells.map(c => (
            <Text key={c.name} color={c.color} dimColor={c.kind !== 'used'}>
              {(c.kind === 'free' ? '░' : c.kind === 'buffer' ? '▒' : '█').repeat(c.n)}
            </Text>
          ))}
        </Box>
        <Box>
          <Text dimColor>{k(s.segs.filter(c => c.kind === 'used').reduce((n, c) => n + c.tokens, 0))}/{k(s.max)} ({Math.round(s.percent)}%) </Text>
          {s.segs.filter(c => c.kind === 'used').map(c => (
            <Text key={c.name} color={c.color}>■ {c.name} {k(c.tokens)}  </Text>
          ))}
        </Box>
      </Box>
    )
  })
}

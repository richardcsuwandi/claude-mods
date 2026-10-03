export type Bar = { label: string; percent: number }
export type Snap = { bars: Bar[]; usd: number | null }

declare module 'claude-code' {
  interface PluginState {
    'usage-bar': { isOn: boolean; snap: Snap | null; isNudged: boolean }
  }
}

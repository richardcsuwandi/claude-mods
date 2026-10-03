export type Seg = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }
export type Snap = { segs: Seg[]; max: number; percent: number }

declare module 'claude-code' {
  interface PluginState {
    'context-bar': { isOn: boolean; snap: Snap | null }
  }
}

// 全局键盘快捷键注册表
// 模式:useShortcut 写入 binding,ShortcutRoot 集中执行。
// 不用 useSyncExternalStore 是因为我们只在 window 维护一个 keydown 监听器,
// 集中处理所有 binding,避免每个 binding 一个 listener 的性能损耗。

export type ShortcutScope = 'global' | 'chat' | 'sessions' | 'page'

export interface ShortcutBinding {
  id: string
  combo: string // 形如 'mod+k'、'mod+shift+r'、'/'、'mod+/'
  description: string
  run: () => void
  scope?: ShortcutScope
}

const registry = new Map<string, ShortcutBinding>()

export function registerShortcut(binding: ShortcutBinding): void {
  registry.set(binding.id, binding)
}

export function unregisterShortcut(id: string): void {
  registry.delete(id)
}

export function getRegisteredShortcuts(): ShortcutBinding[] {
  return Array.from(registry.values())
}

// 全局命令面板:WP3 调色板组件会调 setOpenCommandPaletteHandler 挂上 open 函数;
// useShortcut 注册 'mod+k' 时调用 openCommandPalette(),解耦双方。
let openCommandPaletteHandler: (() => void) | null = null

export function setOpenCommandPaletteHandler(handler: (() => void) | null): void {
  openCommandPaletteHandler = handler
}

export function openCommandPalette(): void {
  openCommandPaletteHandler?.()
}

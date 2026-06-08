import { useEffect, useRef } from 'react'
import {
  registerShortcut,
  unregisterShortcut,
  getRegisteredShortcuts,
  type ShortcutBinding,
} from '@/lib/shortcut-registry'

export type { ShortcutBinding, ShortcutScope } from '@/lib/shortcut-registry'

// 解析 'mod+k'、'mod+shift+r'、'/'、'mod+/' 这类组合。
// mod = Meta(macOS)/Ctrl(其他平台)。
export function parseCombo(combo: string): { mod: boolean; shift: boolean; alt: boolean; key: string } {
  const result = { mod: false, shift: false, alt: false, key: '' }
  for (const part of combo.toLowerCase().split('+')) {
    const p = part.trim()
    if (p === 'mod' || p === 'meta' || p === 'ctrl' || p === 'cmd') result.mod = true
    else if (p === 'shift') result.shift = true
    else if (p === 'alt' || p === 'option') result.alt = true
    else result.key = p
  }
  return result
}

export function isTextInputFocused(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (el.isContentEditable) return true
  return false
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform)
}

// 集中执行所有注册的快捷键。挂在 RootLayout,只跑一次。
export function ShortcutRoot(): null {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isMac = isMacPlatform()
      const all = getRegisteredShortcuts()
      for (const s of all) {
        const parsed = parseCombo(s.combo)
        const keyMatches = e.key.toLowerCase() === parsed.key
        const modMatches = parsed.mod
          ? isMac ? e.metaKey : e.ctrlKey
          : isMac ? !e.metaKey : !e.ctrlKey
        const shiftMatches = parsed.shift ? e.shiftKey : !e.shiftKey
        const altMatches = parsed.alt ? e.altKey : !e.altKey
        if (!keyMatches || !modMatches || !shiftMatches || !altMatches) continue

        // scope 规则:
        // - 组合键(mod/shift/alt)即使在 input 里也允许触发
        // - 单键(例如 '/')在 input 里不触发
        const isCombo = parsed.mod || parsed.shift || parsed.alt
        if (isTextInputFocused() && !isCombo) continue

        e.preventDefault()
        s.run()
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  return null
}

export function useShortcut(binding: ShortcutBinding | ShortcutBinding[]): void {
  // 用 ref 持有最新 binding 引用,避免在每次 render 都重注册;
  // useEffect 只在 id 列表变化时才重注册。
  const ref = useRef(binding)
  ref.current = binding
  const ids = Array.isArray(binding) ? binding.map(b => b.id).join(',') : binding.id
  useEffect(() => {
    const list = Array.isArray(ref.current) ? ref.current : [ref.current]
    for (const b of list) registerShortcut(b)
    return () => {
      for (const b of list) unregisterShortcut(b.id)
    }
  }, [ids])
}

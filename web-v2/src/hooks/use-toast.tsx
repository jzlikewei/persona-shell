import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { uuid } from '@/lib/utils'

export type ToastTone = 'info' | 'success' | 'error'

export interface ToastInput {
  title: string
  description?: string
  tone?: ToastTone
  durationMs?: number
  dedupeMs?: number
}

export interface ToastEntry {
  id: string
  title: string
  description?: string
  tone: ToastTone
  durationMs: number
  createdAt: number
}

interface ToastContextValue {
  toasts: ToastEntry[]
  toast: (input: ToastInput) => void
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const DEFAULT_DURATION: Record<ToastTone, number> = {
  info: 4000,
  success: 4000,
  error: 6000,
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([])
  // title → last shown timestamp (ms). 用 ref 避免 stale closure 又不触发 re-render。
  const lastSeenRef = useRef<Map<string, number>>(new Map())

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  const toast = useCallback((input: ToastInput) => {
    const tone: ToastTone = input.tone ?? 'info'
    const dedupeMs = input.dedupeMs ?? 1500
    const durationMs = input.durationMs ?? DEFAULT_DURATION[tone]
    const now = Date.now()
    const lastSeen = lastSeenRef.current.get(input.title) ?? 0

    // Dedupe: 在窗口内,只替换最近一条同 title 的(不堆叠 spam)
    if (dedupeMs > 0 && now - lastSeen < dedupeMs) {
      lastSeenRef.current.set(input.title, now)
      setToasts(prev => {
        const idx = prev.findIndex(t => t.title === input.title)
        if (idx === -1) {
          // 没有现成同 title —— 加一条新的
          return [
            ...prev,
            { id: uuid(), title: input.title, description: input.description, tone, durationMs, createdAt: now },
          ]
        }
        const existing = prev[idx]
        const next = prev.slice()
        next[idx] = {
          id: existing.id,
          title: input.title,
          description: input.description ?? existing.description,
          tone,
          durationMs,
          createdAt: now,
        }
        return next
      })
      return
    }

    lastSeenRef.current.set(input.title, now)
    const entry: ToastEntry = {
      id: uuid(),
      title: input.title,
      description: input.description,
      tone,
      durationMs,
      createdAt: now,
    }
    setToasts(prev => [...prev, entry])
  }, [])

  // Auto-dismiss: 监听 toasts 列表变化,为每条(非 sticky)安排 timeout。
  useEffect(() => {
    if (toasts.length === 0) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const now = Date.now()
    for (const t of toasts) {
      if (t.durationMs <= 0) continue
      const remain = t.durationMs - (now - t.createdAt)
      timers.push(setTimeout(() => dismiss(t.id), Math.max(remain, 0)))
    }
    return () => timers.forEach(clearTimeout)
  }, [toasts, dismiss])

  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss }}>
      {children}
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return ctx
}

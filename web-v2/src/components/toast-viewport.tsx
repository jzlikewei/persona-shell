import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast, type ToastTone } from '@/hooks/use-toast.tsx'

const TONE_BORDER: Record<ToastTone, string> = {
  info: 'border-l-blue-500',
  success: 'border-l-emerald-500',
  error: 'border-l-destructive',
}

const TONE_BG: Record<ToastTone, string> = {
  info: 'bg-blue-500/10',
  success: 'bg-emerald-500/10',
  error: 'bg-destructive/10',
}

const TONE_ICON: Record<ToastTone, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
}

const TONE_ICON_COLOR: Record<ToastTone, string> = {
  info: 'text-blue-500',
  success: 'text-emerald-500',
  error: 'text-destructive',
}

export function ToastViewport() {
  const { toasts, dismiss } = useToast()
  // createPortal 需要 document.body,客户端首次渲染时才有。
  // 用 mounted state 避免在 SSR/水合阶段触发。
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  if (!mounted || typeof document === 'undefined') return null

  return createPortal(
    <div
      // z-[200] 高于 sheet(scrim 默认 z-50)+ dropdown(40),确保在所有 UI 之上。
      // pointer-events-none 让背后可点击;每条 toast 自己 pointer-events-auto 恢复。
      className="pointer-events-none fixed top-4 right-4 z-[200] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map(t => {
        const Icon = TONE_ICON[t.tone]
        return (
          <div
            key={t.id}
            role="status"
            // data-state 配合 index.css 的 keyframe 动画(via .toast-enter / .toast-exit)
            data-state="open"
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-md border-l-4 border bg-card p-3 shadow-lg',
              'toast-enter',
              TONE_BORDER[t.tone],
              TONE_BG[t.tone]
            )}
          >
            <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', TONE_ICON_COLOR[t.tone])} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-card-foreground">{t.title}</div>
              {t.description && (
                <div className="mt-0.5 text-xs text-muted-foreground">{t.description}</div>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Dismiss notification"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>,
    document.body
  )
}

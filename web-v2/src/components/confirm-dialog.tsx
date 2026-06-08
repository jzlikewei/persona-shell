import { useState } from 'react'
import { Button } from '@/components/ui/button'

export interface ConfirmDialogCheckbox {
  id: string
  label: string
  defaultChecked?: boolean
}

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /**
   * 可选复选框列表(用于"附加操作"如"also kill Director")。
   * ConfirmDialog 内部维护状态,onConfirm 时把状态以 id→bool 形式传回。
   */
  extraCheckboxes?: ConfirmDialogCheckbox[]
  onConfirm: (extraState: Record<string, boolean>) => void | Promise<void>
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = '确认',
  cancelLabel = '取消',
  destructive = false,
  extraCheckboxes = [],
  onConfirm,
}: ConfirmDialogProps) {
  const [extraState, setExtraState] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(extraCheckboxes.map(cb => [cb.id, cb.defaultChecked ?? false]))
  )
  const [busy, setBusy] = useState(false)
  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[160] flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="w-[440px] max-w-[calc(100vw-2rem)] rounded-lg border bg-card p-5 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-card-foreground">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        {extraCheckboxes.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {extraCheckboxes.map(cb => (
              <label key={cb.id} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={extraState[cb.id] ?? false}
                  onChange={e => setExtraState(s => ({ ...s, [cb.id]: e.target.checked }))}
                  className="size-3.5 accent-primary"
                />
                {cb.label}
              </label>
            ))}
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onConfirm(extraState)
              } finally {
                setBusy(false)
                onOpenChange(false)
              }
            }}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}

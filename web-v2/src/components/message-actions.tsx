import { Copy, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/toast'

interface MessageActionsProps {
  messageId: string
  content: string
  hidden: boolean
  onCopy?: () => void
  onHide?: () => void
  onShow?: () => void
}

export function MessageActions({ content, hidden, onCopy, onHide, onShow }: MessageActionsProps) {
  const { toast } = useToast()

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content)
      toast({ title: '已复制', tone: 'success', durationMs: 2000 })
    } catch {
      toast({ title: '复制失败', description: '浏览器拒绝访问剪贴板', tone: 'error' })
    }
  }

  return (
    <div
      className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
    >
      {onCopy && (
        <Button variant="ghost" size="icon-xs" onClick={handleCopy} title="复制" aria-label="Copy message">
          <Copy className="size-3" />
        </Button>
      )}
      {hidden ? (
        onShow && (
          <Button variant="ghost" size="icon-xs" onClick={() => onShow()} title="恢复显示" aria-label="Show message">
            <EyeOff className="size-3" />
          </Button>
        )
      ) : (
        onHide && (
          <Button variant="ghost" size="icon-xs" onClick={() => onHide()} title="隐藏" aria-label="Hide message">
            <EyeOff className="size-3" />
          </Button>
        )
      )}
    </div>
  )
}

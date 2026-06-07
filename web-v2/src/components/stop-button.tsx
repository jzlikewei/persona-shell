import { Send, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface StopOrSendProps {
  isStreaming: boolean
  /** POST /api/send 飞行中(短暂) */
  isSending: boolean
  /** 文本为空 / 正在上传附件 */
  isDisabled: boolean
  onSend: () => void
  onStop: () => void
}

export function StopOrSend({ isStreaming, isSending, isDisabled, onSend, onStop }: StopOrSendProps) {
  if (isStreaming) {
    return (
      <Button
        type="button"
        onClick={onStop}
        size="icon-lg"
        variant="destructive"
        title="中断当前 turn"
        aria-label="Stop generating"
        className="shrink-0"
      >
        <Square className="size-4 fill-current" />
      </Button>
    )
  }
  return (
    <Button
      type="button"
      onClick={onSend}
      size="icon-lg"
      disabled={isDisabled || isSending}
      title={isSending ? '发送中...' : '发送'}
      aria-label="Send message"
      className="shrink-0"
    >
      <Send className="size-4" />
    </Button>
  )
}

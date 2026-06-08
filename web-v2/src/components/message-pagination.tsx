import { Loader2, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface MessagePaginationProps {
  loading: boolean
  loadedCount: number
  totalApprox?: number
  onLoadMore: () => void
}

/** "Load earlier" 按钮。注意:后端无 cursor,只能"调大 limit 重拉窗口" */
export function MessagePagination({ loading, loadedCount, onLoadMore }: MessagePaginationProps) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-b border-border bg-card/30 px-3 py-1.5 text-xs text-muted-foreground">
      <span>
        已显示 {loadedCount} 条 · 点击加载更早(最多 500 条最近)
      </span>
      <Button variant="outline" size="xs" onClick={onLoadMore} disabled={loading}>
        {loading ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
        加载更早
      </Button>
    </div>
  )
}

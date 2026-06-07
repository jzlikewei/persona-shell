import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

interface MessageSearchProps {
  value: string
  onChange: (value: string) => void
  matchCount?: number
}

/** sticky 在消息列表顶部的搜索条,客户端 substring 过滤 */
export function MessageSearch({ value, onChange, matchCount }: MessageSearchProps) {
  const [local, setLocal] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  // 把父组件的 value 同步回 local(例如外部触发 "清空")
  useEffect(() => {
    setLocal(value)
  }, [value])

  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card/50 px-3 py-1.5">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={local}
        onChange={e => {
          setLocal(e.target.value)
          onChange(e.target.value)
        }}
        placeholder="搜索消息内容…"
        className="h-6 flex-1 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
      />
      {local && (
        <span className="font-mono text-[10px] text-muted-foreground">
          {matchCount !== undefined ? `${matchCount} matches` : '过滤中'}
        </span>
      )}
      {local && (
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            setLocal('')
            onChange('')
            inputRef.current?.focus()
          }}
          title="清空"
          aria-label="Clear search"
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  )
}

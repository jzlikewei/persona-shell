import { isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { CheckCircle2, Loader2, Paperclip, Terminal, XCircle } from 'lucide-react'
import { CodeBlock } from '@/components/code-block'
import { DocumentPanel, extractFilePaths } from '@/components/document-panel'
import { StopOrSend } from '@/components/stop-button'
import { MessageSearch } from '@/components/message-search'
import { MessagePagination } from '@/components/message-pagination'
import { DateSeparator } from '@/components/date-separator'
import { useApi } from '@/hooks/use-api'
import { useChat, type ChatMessage, type ChatToolCall } from '@/hooks/use-chat'
import type { ShellOutletContext } from '@/layouts/root-layout'
import { cn } from '@/lib/utils'

function formatTime(ts: string) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function visibleMessages(messages: ChatMessage[]) {
  return messages.filter(msg => {
    if (msg.role === 'system') return false
    return true
  })
}

function FileLink({ path, onClick }: { path: string; onClick: (path: string) => void }) {
  return (
    <button
      onClick={() => onClick(path)}
      className="inline-flex items-center rounded bg-[#89b4fa]/15 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[.03em] text-[#89b4fa] hover:bg-[#89b4fa]/25"
    >
      {path.split('/').pop()}
    </button>
  )
}

interface UploadedAttachment {
  path: string
  name: string
  size: number
  kind: 'markdown' | 'text' | 'image' | 'file'
}

interface UploadResponse {
  ok: boolean
  files: UploadedAttachment[]
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children)
  return ''
}

function looksLikeFilePath(text: string): boolean {
  const trimmed = text.trim()
  return /^(\/|~\/|\.\/)[^\s]+\.\w{1,10}$/.test(trimmed)
}

// 用 memo 包,避免父组件重渲时整段 markdown 重新 parse(rehype-highlight 是大头)
// rehype-highlight 关闭 detect:false —— 无 language-X className 的 code 不再自动猜测语言,
// inline `code` 这种小片段就走"原始文本"路径,省掉一大波 highlight.js tokenization
const REHYPE_HIGHLIGHT_OPTIONS = { detect: false, ignoreMissing: true } as const
const MarkdownContent = memo(function MarkdownContent({ content, onFileClick }: { content: string; onFileClick?: (path: string) => void }) {
  return (
    <div className="md-content prose prose-sm prose-invert max-w-none text-[#bac2de] [&_a]:text-[#89b4fa] [&_code]:rounded [&_code]:bg-[#45475a] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-[#fab387] [&_ol]:my-1 [&_p]:my-1.5 [&_pre]:my-2 [&_ul]:my-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, REHYPE_HIGHLIGHT_OPTIONS]]}
        components={{
          pre({ children }) {
            return <>{children}</>
          },
          code({ className, children, ...props }) {
            const text = extractText(children)
            const isBlock = className?.includes('language-') ||
              text.includes('\n')
            if (isBlock) {
              return (
                <CodeBlock className={className}>
                  {text.replace(/\n$/, '')}
                </CodeBlock>
              )
            }
            if (onFileClick && looksLikeFilePath(text)) {
              return (
                <code
                  className={cn(className, 'cursor-pointer !text-[#89b4fa] hover:!bg-[#89b4fa]/20 transition-colors')}
                  onClick={() => onFileClick(text.trim())}
                  title="点击预览文件"
                  {...props}
                >
                  {children}
                </code>
              )
            }
            return <code className={className} {...props}>{children}</code>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})

// 单个 tool call 的折叠详情 —— 默认折叠时不渲染 body,展开后再 mount
// 这是 chat 卡顿的最大头:不 lazy 的话,N 条消息 × 平均 3 个 tool × 2 个 <pre> 全部进 DOM
const ToolDetail = memo(function ToolDetail({ tool, index }: { tool: ChatToolCall; index: number }) {
  const [opened, setOpened] = useState(false)
  const isError = !!tool.isError
  const isRunning = tool.status === 'running'
  return (
    <details
      key={tool.id ?? `${tool.name}-${index}`}
      className={cn(
        'rounded border bg-[#11111b] text-xs',
        isError ? 'border-[#f38ba8]/35' : 'border-[#313244]'
      )}
      onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 font-mono text-[11px] text-[#a6adc8] marker:hidden">
        <span className="text-[#89b4fa]">&gt;_</span>
        <span className="truncate font-bold text-[#cdd6f4]">{tool.name}</span>
        <span className={cn('ml-auto inline-flex items-center gap-1', isError ? 'text-[#f38ba8]' : isRunning ? 'text-[#89b4fa]' : 'text-[#a6e3a1]')}>
          {isError ? <XCircle className="size-3" /> : isRunning ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
          {isError ? 'error' : isRunning ? 'running' : 'done'}
        </span>
      </summary>
      {opened && (
        <div className="space-y-1.5 border-t border-[#313244] px-2 py-2">
          {tool.input && (
            <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded bg-[#181825] p-2 font-mono text-[10px] leading-relaxed text-[#bac2de]">{tool.input}</pre>
          )}
          {tool.result && (
            <pre className={cn(
              'max-h-44 overflow-auto whitespace-pre-wrap rounded p-2 font-mono text-[10px] leading-relaxed',
              isError ? 'bg-[#f38ba8]/10 text-[#f5c2e7]' : 'bg-[#181825] text-[#a6adc8]'
            )}>{tool.result}</pre>
          )}
        </div>
      )}
    </details>
  )
})

const ToolCalls = memo(function ToolCalls({ tools }: { tools?: ChatToolCall[] }) {
  // 外层 Tools 折叠组也 lazy,默认收起时不 mount 任何 ToolDetail
  const [opened, setOpened] = useState(false)
  if (!tools?.length) return null
  const hasRunning = tools.some(tool => tool.status === 'running')
  const hasError = tools.some(tool => tool.isError || tool.status === 'failed')

  return (
    <details
      className="mt-1.5 rounded-md border border-[#45475a] bg-[#181825] text-xs"
      onToggle={(e) => setOpened((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 font-mono text-[11px] text-[#a6adc8] marker:hidden">
        <Terminal className="size-3.5 text-[#89b4fa]" />
        <span className="font-bold text-[#cdd6f4]">Tools</span>
        <span className="rounded bg-[#313244] px-1.5 py-0.5 text-[10px] text-[#bac2de]">{tools.length} calls</span>
        <span className={cn(
          'ml-auto inline-flex items-center gap-1',
          hasError ? 'text-[#f38ba8]' : hasRunning ? 'text-[#89b4fa]' : 'text-[#a6e3a1]'
        )}>
          {hasError ? <XCircle className="size-3" /> : hasRunning ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle2 className="size-3" />}
          {hasError ? 'has error' : hasRunning ? 'running' : 'done'}
        </span>
      </summary>
      {opened && (
        <div className="space-y-1 border-t border-[#313244] p-1.5">
          {tools.map((tool, index) => (
            <ToolDetail key={tool.id ?? `${tool.name}-${index}`} tool={tool} index={index} />
          ))}
        </div>
      )}
    </details>
  )
})

// memo:列表项最贵的就是 markdown 重 parse;父组件每次重渲不应触发整列表 re-mount
const MessageBlock = memo(function MessageBlock({
  message,
  onFileClick,
}: {
  message: ChatMessage
  onFileClick: (path: string) => void
}) {
  const isUser = message.role === 'user'
  const filePaths = extractFilePaths(message.content)
  // user 消息也走 MarkdownContent,但无 markdown 提示时回退到 pre-wrap,
  // 避免无意义 reparse。
  const hasMarkdown = /[*_`#\[\]]/.test(message.content)

  return (
    <article
      className={cn('group relative mb-3 flex w-full overflow-hidden px-4', isUser ? 'justify-end' : 'justify-start')}
    >
      <div className={cn('flex flex-col overflow-hidden', isUser ? 'max-w-[min(72%,760px)] items-end' : 'max-w-[min(76%,780px)] items-start')}>
        <div className={cn('mb-1 flex items-center gap-2', isUser && 'justify-end')}>
          <span className={cn(
            'font-mono text-[11px] font-extrabold uppercase tracking-[.05em]',
            isUser ? 'text-[#89b4fa]' : 'text-[#a6e3a1]'
          )}>
            {isUser ? 'User' : message.agentLabel || 'Agent'}
          </span>
          <span className="font-mono text-[10px] text-[#6c7086]">{formatTime(message.timestamp)}</span>
          {!isUser && message.model && (
            <span className="font-mono text-[10px] text-[#585b70]">{message.model}</span>
          )}
        </div>
        <div className={cn(
          'max-w-full rounded-md px-3 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]',
          isUser
            ? 'border-r-[3px] border-[#89b4fa] bg-[#89b4fa]/[.08] text-right text-[#cdd6f4]'
            : 'border-l-[3px] border-[#a6e3a1] bg-[#313244] text-[#bac2de]'
        )}>
          {isUser
            ? (hasMarkdown
                ? <MarkdownContent content={message.content} onFileClick={onFileClick} />
                : <div className="whitespace-pre-wrap text-left">{message.content}</div>)
            : <MarkdownContent content={message.content} onFileClick={onFileClick} />}
        </div>
        {!isUser && <ToolCalls tools={message.tools} />}
        {filePaths.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {filePaths.slice(0, 5).map(path => (
              <FileLink key={path} path={path} onClick={onFileClick} />
            ))}
          </div>
        )}
      </div>
    </article>
  )
})

function StreamingBlock({ phase, text, tools }: { phase: 'thinking' | 'streaming' | 'tool_running'; text: string; tools?: ChatToolCall[] }) {
  const statusLabel = phase === 'thinking' ? 'thinking' : phase === 'streaming' ? 'streaming' : 'working'
  const lastRunningTool = tools?.filter(t => t.status === 'running').slice(-1)[0]
  return (
    <article className="mb-3 flex justify-start px-4">
      <div className="flex max-w-[min(76%,780px)] flex-col items-start">
        <div className="mb-1 flex items-center gap-2">
          <span className="font-mono text-[11px] font-extrabold uppercase tracking-[.05em] text-[#a6e3a1]">Agent</span>
          <span className="font-mono text-[10px] text-[#6c7086]">{statusLabel}</span>
        </div>
        <div className="w-fit rounded-md border-l-[3px] border-[#a6e3a1] bg-[#313244] px-3 py-2 text-sm leading-relaxed text-[#bac2de]">
          {text ? (
            <>
              <MarkdownContent content={text} />
              {phase === 'streaming' && <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-[#a6e3a1]" />}
              {phase === 'tool_running' && (
                <div className="mt-2 flex items-center gap-2 font-mono text-xs text-[#a6adc8]">
                  <Loader2 className="size-3 animate-spin text-[#89b4fa]" />
                  <span>执行 {lastRunningTool?.name ?? 'tool'}…</span>
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-2 font-mono text-xs text-[#a6adc8]">
              <Loader2 className="size-3.5 animate-spin text-[#89b4fa]" />
              {phase === 'thinking' && <span>思考中…</span>}
              {phase === 'streaming' && <span>接收中…</span>}
              {phase === 'tool_running' && <span>执行 {lastRunningTool?.name ?? 'tool'}…</span>}
            </div>
          )}
        </div>
        <div className="w-full max-w-[min(76vw,780px)]">
          <ToolCalls tools={tools} />
        </div>
      </div>
    </article>
  )
}

function shortPath(path?: string) {
  if (!path) return '-'
  return path.replace(/^\/Users\/[^/]+/, '~')
}

function WorkspaceSummary({
  projectName,
  workspaceName,
  workspacePath,
  sessionLabel,
  sessionId,
}: {
  projectName?: string
  workspaceName?: string
  workspacePath?: string
  sessionLabel?: string
  sessionId?: string
}) {
  return (
    <>
      <div className="mb-3 grid gap-2 px-4 md:grid-cols-3">
        <div className="rounded-md bg-[#313244] px-3 py-2">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Project Directory</div>
          <div className="truncate font-mono text-sm font-bold text-[#cdd6f4]">{projectName ?? '-'}</div>
        </div>
        <div className="rounded-md bg-[#313244] px-3 py-2">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Workspace</div>
          <div className="truncate font-mono text-sm font-bold text-[#cdd6f4]">{workspaceName ?? '-'}</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-[#7f849c]">{shortPath(workspacePath)}</div>
        </div>
        <div className="rounded-md bg-[#313244] px-3 py-2">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#7f849c]">Selected Session</div>
          <div className="truncate font-mono text-sm font-bold text-[#cdd6f4]">{sessionLabel ?? '-'}</div>
          <div className="mt-0.5 truncate font-mono text-[10px] text-[#7f849c]">{sessionId ?? '-'}</div>
        </div>
      </div>
    </>
  )
}

function EmptyConversation() {
  return (
    <div className="mx-4 rounded-md border-l-[3px] border-[#a6e3a1] bg-[#313244] px-3 py-2 text-sm leading-relaxed text-[#bac2de]">
      <p>没有历史对话</p>
    </div>
  )
}

export function ChatPage() {
  const {
    activeProject,
    activeWorkspace,
    workspaceName,
    activeSession,
    activeSessionInfo,
    setActiveSession,
  } = useOutletContext<ShellOutletContext>()
  const { messages, streaming, streamingTools, activity, turnPhase, loading, sending, sendMessage, loadMore } = useChat(activeSession, activeSessionInfo?.alive ?? false, workspaceName)
  const { request } = useApi()
  const isStreaming = turnPhase !== null || streaming.length > 0 || streamingTools.length > 0
  // 搜索状态在 ChatPage 内管,不污染 use-chat 抽象
  const [searchQuery, setSearchQuery] = useState('')
  const draftKey = activeSession ? `persona-shell:v2:draft:${activeSession}` : null
  const [input, setInput] = useState(() => {
    if (!draftKey) return ''
    return localStorage.getItem(draftKey) ?? ''
  })

  useEffect(() => {
    if (draftKey) {
      const saved = localStorage.getItem(draftKey) ?? ''
      setInput(saved)
    } else {
      setInput('')
    }
  }, [draftKey])

  const updateInput = useCallback((value: string) => {
    setInput(value)
    if (draftKey) {
      if (value) localStorage.setItem(draftKey, value)
      else localStorage.removeItem(draftKey)
    }
  }, [draftKey])
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Virtuoso 自带 followOutput / atBottom 检测,不需要手写 scrollRef/handleScroll/userScrolled
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  // 用户是否已贴底:决定流式新内容是平滑滚动还是停滞(尊重用户上滑阅读历史)
  const atBottomRef = useRef(true)
  const filteredMessages = useMemo(() => {
    let result = visibleMessages(messages)
    // 搜索过滤:substring 大小写不敏感
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      result = result.filter(m => m.content.toLowerCase().includes(q))
    }
    return result
  }, [messages, searchQuery])

  const attachmentText = useCallback((files: UploadedAttachment[]) => {
    if (files.length === 0) return ''
    return [
      '附件：',
      ...files.map(file => `- ${file.name} (${file.kind}, ${formatBytes(file.size)}): ${file.path}`),
    ].join('\n')
  }, [])

  const handleSend = () => {
    const body = input.trim()
    if ((!body && attachments.length === 0) || sending || uploading) return
    const filesText = attachmentText(attachments)
    const content = [body, filesText].filter(Boolean).join('\n\n')
    sendMessage(content, setActiveSession)
    updateInput('')
    setAttachments([])
    setUploadError(null)
    // 发出消息后强制重新贴底:用户可能正在上面看历史,此刻应跟着新消息走
    atBottomRef.current = true
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' })
    if (textareaRef.current) textareaRef.current.style.height = ''
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      handleSend()
    }
  }

  const handlePaste = (event: React.ClipboardEvent) => {
    const items = Array.from(event.clipboardData.items)
    const imageFiles = items
      .filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (imageFiles.length > 0) {
      event.preventDefault()
      uploadFiles(imageFiles)
    }
  }

  const handleTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    updateInput(event.target.value)
    const el = event.target
    el.style.height = 'auto'
    el.style.height = Math.min(Math.max(el.scrollHeight, 82), 220) + 'px'
  }

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return
    const form = new FormData()
    files.forEach(file => form.append('files', file, file.name))
    setUploading(true)
    setUploadError(null)
    try {
      const result = await request<UploadResponse>('/api/files/upload', { method: 'POST', body: form })
      setAttachments(prev => [...prev, ...(result.files ?? [])])
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragOver(false)
    const files = Array.from(event.dataTransfer.files)
    uploadFiles(files)
  }

  const removeAttachment = (path: string) => {
    setAttachments(prev => prev.filter(file => file.path !== path))
  }

  // Virtuoso 列表的数据 —— 把 streaming/loading 拼到末尾,作为虚拟列表的最后一项,
  // 它们高度变化由 Virtuoso 的 ResizeObserver 自动跟随,无需手动 scrollTo
  type StreamingTail = { __kind: 'streaming'; phase: 'thinking' | 'streaming' | 'tool_running' }
  type LoadingTail = { __kind: 'loading' }
  type EmptyTail = { __kind: 'empty' }
  type DateSeparatorTail = { __kind: 'date'; date: string }
  type VirtuosoItem = ChatMessage | StreamingTail | LoadingTail | EmptyTail | DateSeparatorTail

  const virtuosoItems = useMemo<VirtuosoItem[]>(() => {
    // 在相邻消息日期变化处插入 DateSeparator;搜索过滤时不插入,以免污染过滤视图
    const items: VirtuosoItem[] = []
    if (searchQuery) {
      // 搜索模式:直接铺平,不插日期分隔
      items.push(...filteredMessages)
    } else {
      let prevDate: string | null = null
      for (const msg of filteredMessages) {
        const msgDate = msg.timestamp.slice(0, 10) // YYYY-MM-DD
        if (msgDate !== prevDate) {
          items.push({ __kind: 'date', date: msg.timestamp })
          prevDate = msgDate
        }
        items.push(msg)
      }
    }
    if (loading && filteredMessages.length === 0) {
      items.push({ __kind: 'loading' })
    } else if (filteredMessages.length === 0 && !streaming && !activity && !turnPhase && !searchQuery) {
      items.push({ __kind: 'empty' })
    }
    if (turnPhase) {
      items.push({ __kind: 'streaming', phase: turnPhase })
    } else if (streaming || activity || streamingTools.length > 0) {
      items.push({ __kind: 'streaming', phase: streaming ? 'streaming' : 'tool_running' })
    }
    return items
  }, [filteredMessages, loading, streaming, activity, turnPhase, streamingTools.length, searchQuery])

  const renderItem = useCallback((_index: number, item: VirtuosoItem) => {
    if ('__kind' in item) {
      if (item.__kind === 'loading') {
        return (
          <div className="mx-4 flex items-center gap-2 rounded-md bg-[#313244] px-3 py-2 text-sm text-[#7f849c]">
            <Loader2 className="size-4 animate-spin" />
            Loading session history...
          </div>
        )
      }
      if (item.__kind === 'empty') return <EmptyConversation />
      if (item.__kind === 'date') return <DateSeparator date={item.date} />
      // streaming
      return <StreamingBlock phase={item.phase} text={streaming} tools={streamingTools} />
    }
    return (
      <MessageBlock
        message={item}
        onFileClick={setPreviewPath}
      />
    )
  }, [streaming, streamingTools])

  const renderHeader = useCallback(() => (
    <WorkspaceSummary
      projectName={activeProject?.name}
      workspaceName={activeWorkspace?.name}
      workspacePath={activeWorkspace?.path}
      sessionLabel={activeSessionInfo?.label}
      sessionId={activeSession}
    />
  ), [activeProject?.name, activeWorkspace?.name, activeWorkspace?.path, activeSessionInfo?.label, activeSession])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#1e1e2e]">
      <MessageSearch value={searchQuery} onChange={setSearchQuery} matchCount={filteredMessages.length} />
      <MessagePagination
        loading={loading}
        loadedCount={filteredMessages.length}
        onLoadMore={loadMore}
      />
      <Virtuoso
        // key 绑定 session:切 session 时强制 remount,避免上一会话的滚动位置和 ResizeObserver
        // 测高过程继续 follow 进新会话,产生"持续滚动几秒"的视觉
        key={activeSession ?? 'no-session'}
        ref={virtuosoRef}
        data={virtuosoItems}
        itemContent={renderItem}
        components={{ Header: renderHeader }}
        // 'auto' = 瞬间贴底,'smooth' 会"追着布局变化跑"产生持续滚动观感
        // 流式追加消息(streaming 来时 data 长度增长)也是 auto:对 chat 来说足够好,
        // 而且避免 mount 期高度收敛过程被平滑动画放大
        followOutput={atBottomRef.current ? 'auto' : false}
        atBottomStateChange={(atBottom) => { atBottomRef.current = atBottom }}
        // 切换 session 时跳到最底(像普通 chat 一样从最新看起)
        initialTopMostItemIndex={virtuosoItems.length > 0 ? virtuosoItems.length - 1 : 0}
        increaseViewportBy={{ top: 200, bottom: 400 }}
        className="min-h-0 flex-1 overflow-x-hidden py-3"
      />

      <div
        className={cn(
          'flex shrink-0 flex-col gap-2 overflow-hidden border-t border-[#45475a] bg-[#181825] p-3',
          dragOver && 'bg-[#313244]'
        )}
        onDragOver={event => { event.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {(attachments.length > 0 || uploadError) && (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map(file => (
              <span
                key={file.path}
                className="inline-flex max-w-[320px] items-center gap-1.5 rounded bg-[#313244] px-2 py-1 font-mono text-[10px] text-[#bac2de]"
              >
                <Paperclip className="size-3 text-[#89b4fa]" />
                <button onClick={() => setPreviewPath(file.path)} className="truncate text-left text-[#cdd6f4] hover:text-[#89b4fa]">
                  {file.name}
                </button>
                <span className="text-[#6c7086]">{formatBytes(file.size)}</span>
                <button onClick={() => removeAttachment(file.path)} className="ml-0.5 text-[#f38ba8] hover:text-[#eba0ac]">
                  ×
                </button>
              </span>
            ))}
            {uploadError && (
              <span className="rounded bg-[#f38ba8]/10 px-2 py-1 font-mono text-[10px] text-[#f38ba8]">{uploadError}</span>
            )}
          </div>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={event => uploadFiles(Array.from(event.target.files ?? []))}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-md text-[#7f849c] hover:bg-[#313244] disabled:opacity-50"
            title="Attach files"
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Message current workspace... (Enter 发送, Shift+Enter 换行)"
            rows={3}
            className="min-h-[82px] max-h-[220px] min-w-0 flex-1 resize-none rounded-md border border-[#45475a] bg-[#313244] px-3 py-2.5 text-sm leading-5 text-[#cdd6f4] outline-none placeholder:text-[#6c7086] focus:border-[#89b4fa]"
          />
          <StopOrSend
            isStreaming={isStreaming}
            isSending={sending}
            isDisabled={!input.trim() && attachments.length === 0}
            onSend={handleSend}
            onStop={() => { void request('/api/esc', { method: 'POST' }) }}
          />
        </div>
      </div>

      {previewPath && (
        <DocumentPanel filePath={previewPath} onClose={() => setPreviewPath(null)} />
      )}
    </div>
  )
}

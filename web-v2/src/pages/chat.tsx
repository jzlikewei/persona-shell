import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { Send, Paperclip, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useChat, type ChatMessage } from '@/hooks/use-chat'
import { useSessions } from '@/hooks/use-sessions'
import { StatusBar } from '@/components/status-bar'
import { SessionList } from '@/components/session-list'
import { DocumentPanel, extractFilePaths } from '@/components/document-panel'
import { CodeBlock } from '@/components/code-block'

function formatTime(ts: string) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function FileLink({ path, onClick }: { path: string; onClick: (path: string) => void }) {
  return (
    <button
      onClick={() => onClick(path)}
      className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-accent/60 hover:bg-accent text-accent-foreground font-mono transition-colors"
    >
      {path.split('/').pop()}
    </button>
  )
}

function MessageBubble({
  message,
  onFileClick,
}: {
  message: ChatMessage
  onFileClick: (path: string) => void
}) {
  const isUser = message.role === 'user'
  const filePaths = isUser ? [] : extractFilePaths(message.content)

  return (
    <div className={cn('flex gap-2', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn('flex flex-col gap-1 max-w-[85%]')}>
        <div className={cn(
          'rounded-lg px-4 py-2.5 text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground'
        )}>
          {isUser ? (
            <p className="whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="prose prose-sm prose-invert max-w-none [&_pre]:bg-background/50 [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:my-2 [&_code]:text-xs">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                components={{
                  pre({ children }) {
                    return <>{children}</>
                  },
                  code({ className, children, ...props }) {
                    const isBlock = className?.includes('language-') ||
                      (typeof children === 'string' && children.includes('\n'))
                    if (isBlock) {
                      return (
                        <CodeBlock className={className}>
                          {String(children).replace(/\n$/, '')}
                        </CodeBlock>
                      )
                    }
                    return <code className={className} {...props}>{children}</code>
                  },
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
        <div className={cn('flex items-center gap-2 px-1', isUser ? 'justify-end' : 'justify-start')}>
          <span className="text-[10px] text-muted-foreground/60">{formatTime(message.timestamp)}</span>
          {message.director && (
            <span className="text-[10px] text-muted-foreground/40">via {message.director}</span>
          )}
        </div>
        {filePaths.length > 0 && (
          <div className="flex flex-wrap gap-1 px-1">
            {filePaths.slice(0, 5).map(p => (
              <FileLink key={p} path={p} onClick={onFileClick} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StreamingBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg px-4 py-2.5 text-sm bg-muted text-foreground">
        <div className="prose prose-sm prose-invert max-w-none [&_pre]:bg-background/50 [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:my-2 [&_code]:text-xs">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {text}
          </ReactMarkdown>
          <span className="inline-block w-2 h-4 bg-foreground/60 animate-pulse ml-0.5" />
        </div>
      </div>
    </div>
  )
}

export function ChatPage() {
  const { sessions, activeSession, setActiveSession } = useSessions()
  const { messages, streaming, sending, sendMessage } = useChat(activeSession)
  const [input, setInput] = useState('')
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const userScrolled = useRef(false)

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current && !userScrolled.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, streaming, scrollToBottom])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    userScrolled.current = scrollHeight - scrollTop - clientHeight > 100
  }, [])

  const handleSend = () => {
    if (!input.trim() || sending) return
    sendMessage(input.trim())
    setInput('')
    userScrolled.current = false
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      const names = files.map(f => f.name).join(', ')
      setInput(prev => prev + (prev ? '\n' : '') + `[Attached: ${names}]`)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <StatusBar />

      <div className="flex flex-1 overflow-hidden">
        {/* Session list in sidebar area - shown on desktop via parent layout */}
        <div className="hidden lg:flex flex-col w-48 border-r border-border shrink-0">
          <SessionList
            sessions={sessions}
            activeSession={activeSession}
            onSelect={setActiveSession}
          />
        </div>

        {/* Chat main area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Messages */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto p-4"
          >
            <div className="space-y-4 max-w-3xl mx-auto">
              {messages.length === 0 && !streaming && (
                <div className="text-center text-sm text-muted-foreground py-12">
                  No messages yet. Send a message to get started.
                </div>
              )}
              {messages.map(msg => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  onFileClick={setPreviewPath}
                />
              ))}
              {streaming && <StreamingBubble text={streaming} />}
            </div>
          </div>

          {/* Input area */}
          <div
            className={cn(
              'border-t border-border p-4 transition-colors',
              dragOver && 'bg-accent/20 border-accent'
            )}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <div className="max-w-3xl mx-auto flex gap-2 items-end">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                placeholder="Send a message..."
                rows={1}
                className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[38px] max-h-[200px]"
              />
              <Button
                onClick={handleSend}
                size="icon"
                disabled={!input.trim() || sending}
                className="shrink-0"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
            {dragOver && (
              <div className="max-w-3xl mx-auto mt-2 text-xs text-muted-foreground flex items-center gap-1">
                <Paperclip className="h-3 w-3" />
                Drop files to attach
              </div>
            )}
          </div>
        </div>

        {/* Document preview panel */}
        {previewPath && (
          <DocumentPanel filePath={previewPath} onClose={() => setPreviewPath(null)} />
        )}
      </div>
    </div>
  )
}

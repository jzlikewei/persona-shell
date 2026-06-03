import { isValidElement, useCallback, useEffect, useRef, useState, type ReactNode, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import { useOutletContext } from 'react-router'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CheckCircle2, Loader2, Paperclip, Send, Terminal, XCircle } from 'lucide-react'
import { CodeBlock } from '@/components/code-block'
import { DocumentPanel, extractFilePaths } from '@/components/document-panel'
import { useApi } from '@/hooks/use-api'
import { useChat, type ChatMessage, type ChatToolCall } from '@/hooks/use-chat'
import type { Session } from '@/hooks/use-sessions'
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
    const text = msg.content
    if (text.startsWith('[系统]') || text.startsWith('[STARTUP]')) return false
    if (/^\[20\d{2}\/\d+\/\d+/.test(text) && text.includes('[STARTUP]')) return false
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

function MarkdownContent({ content }: { content: string }) {
  return (
    <div className="md-content prose prose-sm prose-invert max-w-none text-[#bac2de] [&_a]:text-[#89b4fa] [&_code]:rounded [&_code]:bg-[#45475a] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-[#fab387] [&_ol]:my-1 [&_p]:my-1.5 [&_pre]:my-2 [&_ul]:my-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
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
            return <code className={className} {...props}>{children}</code>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

function ToolCalls({ tools }: { tools?: ChatToolCall[] }) {
  if (!tools?.length) return null

  return (
    <details className="mt-1.5 rounded-md border border-[#45475a] bg-[#181825] text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 font-mono text-[11px] text-[#a6adc8] marker:hidden">
        <Terminal className="size-3.5 text-[#89b4fa]" />
        <span className="font-bold text-[#cdd6f4]">Tools</span>
        <span className="rounded bg-[#313244] px-1.5 py-0.5 text-[10px] text-[#bac2de]">{tools.length} calls</span>
        <span className={cn(
          'ml-auto inline-flex items-center gap-1',
          tools.some(tool => tool.isError) ? 'text-[#f38ba8]' : 'text-[#a6e3a1]'
        )}>
          {tools.some(tool => tool.isError) ? <XCircle className="size-3" /> : <CheckCircle2 className="size-3" />}
          {tools.some(tool => tool.isError) ? 'has error' : 'done'}
        </span>
      </summary>
      <div className="space-y-1 border-t border-[#313244] p-1.5">
        {tools.map((tool, index) => {
          const isError = !!tool.isError
          return (
            <details
              key={tool.id ?? `${tool.name}-${index}`}
              className={cn(
                'rounded border bg-[#11111b] text-xs',
                isError ? 'border-[#f38ba8]/35' : 'border-[#313244]'
              )}
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 font-mono text-[11px] text-[#a6adc8] marker:hidden">
                <span className="text-[#89b4fa]">&gt;_</span>
                <span className="truncate font-bold text-[#cdd6f4]">{tool.name}</span>
                <span className={cn('ml-auto inline-flex items-center gap-1', isError ? 'text-[#f38ba8]' : 'text-[#a6e3a1]')}>
                  {isError ? <XCircle className="size-3" /> : <CheckCircle2 className="size-3" />}
                  {isError ? 'error' : tool.result ? 'done' : 'call'}
                </span>
              </summary>
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
            </details>
          )
        })}
      </div>
    </details>
  )
}

function MessageBlock({
  message,
  onFileClick,
}: {
  message: ChatMessage
  onFileClick: (path: string) => void
}) {
  const isUser = message.role === 'user'
  const filePaths = extractFilePaths(message.content)

  return (
    <article className={cn('mb-3 flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn('flex flex-col', isUser ? 'max-w-[min(72%,760px)] items-end' : 'max-w-[min(76%,780px)] items-start')}>
        <div className={cn('mb-1 flex items-center gap-2', isUser && 'justify-end')}>
          <span className={cn(
            'font-mono text-[11px] font-extrabold uppercase tracking-[.05em]',
            isUser ? 'text-[#89b4fa]' : 'text-[#a6e3a1]'
          )}>
            {isUser ? 'User' : message.director || 'Director'}
          </span>
          <span className="font-mono text-[10px] text-[#6c7086]">{formatTime(message.timestamp)}</span>
        </div>
        <div className={cn(
          'rounded-md px-3 py-2 text-sm leading-relaxed',
          isUser
            ? 'border-r-[3px] border-[#89b4fa] bg-[#89b4fa]/[.08] text-right text-[#cdd6f4]'
            : 'border-l-[3px] border-[#a6e3a1] bg-[#313244] text-[#bac2de]'
        )}>
          {isUser ? <div className="whitespace-pre-wrap text-left">{message.content}</div> : <MarkdownContent content={message.content} />}
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
}

function StreamingBlock({ text }: { text: string }) {
  return (
    <article className="mb-3 flex justify-start">
      <div className="flex max-w-[min(76%,780px)] flex-col items-start">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-mono text-[11px] font-extrabold uppercase tracking-[.05em] text-[#a6e3a1]">Director</span>
        <span className="font-mono text-[10px] text-[#6c7086]">streaming</span>
      </div>
      <div className="w-fit rounded-md border-l-[3px] border-[#a6e3a1] bg-[#313244] px-3 py-2 text-sm leading-relaxed text-[#bac2de]">
        <MarkdownContent content={text} />
        <span className="ml-1 inline-block h-4 w-2 animate-pulse bg-[#a6e3a1]" />
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
  directorLabel,
  sessionLabel,
  sessionId,
}: {
  projectName?: string
  workspaceName?: string
  workspacePath?: string
  directorLabel: string
  sessionLabel?: string
  sessionId?: string
}) {
  return (
    <>
      <div className="mb-3 grid gap-2 md:grid-cols-3">
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
          <div className="mt-0.5 truncate font-mono text-[10px] text-[#7f849c]">{directorLabel} · {sessionId ?? '-'}</div>
        </div>
      </div>
    </>
  )
}

function EmptyConversation() {
  return (
    <div className="rounded-md border-l-[3px] border-[#a6e3a1] bg-[#313244] px-3 py-2 text-sm leading-relaxed text-[#bac2de]">
      <p>没有历史对话</p>
    </div>
  )
}

function SessionRail({
  sessions,
  activeSession,
  onSelect,
}: {
  sessions: Session[]
  activeSession?: string
  onSelect: (id: string) => void
}) {
  if (sessions.length === 0) return null

  return (
    <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1">
      {sessions.map(session => (
        <button
          key={session.id}
          onClick={() => onSelect(session.id)}
          className={cn(
            'flex h-7 shrink-0 items-center gap-1.5 rounded px-2 font-mono text-[11px] font-bold transition-colors',
            session.id === activeSession ? 'bg-[#45475a] text-[#cdd6f4]' : 'bg-[#313244] text-[#7f849c] hover:text-[#cdd6f4]'
          )}
        >
          <span className={cn('size-[6px] rounded-full', session.alive ? 'bg-[#a6e3a1]' : 'bg-[#6c7086]')} />
          <span className="max-w-[220px] truncate">{session.label}</span>
          <span className="text-[#6c7086]">{session.messageCount}</span>
        </button>
      ))}
    </div>
  )
}

export function ChatPage() {
  const {
    activeProject,
    activeWorkspace,
    directorLabel,
    sessions,
    activeSession,
    activeSessionInfo,
    setActiveSession,
  } = useOutletContext<ShellOutletContext>()
  const { messages, streaming, loading, sending, sendMessage } = useChat(directorLabel, activeSession, activeSessionInfo?.alive ?? false)
  const { request } = useApi()
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const userScrolled = useRef(false)
  const filteredMessages = visibleMessages(messages)

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
    sendMessage(content)
    setInput('')
    setAttachments([])
    setUploadError(null)
    userScrolled.current = false
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
    setInput(event.target.value)
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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#1e1e2e]">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
      >
        <WorkspaceSummary
          projectName={activeProject?.name}
          workspaceName={activeWorkspace?.name}
          workspacePath={activeWorkspace?.path}
          directorLabel={directorLabel}
          sessionLabel={activeSessionInfo?.label}
          sessionId={activeSession}
        />
        <SessionRail sessions={sessions} activeSession={activeSession} onSelect={setActiveSession} />
        {loading ? (
          <div className="flex items-center gap-2 rounded-md bg-[#313244] px-3 py-2 text-sm text-[#7f849c]">
            <Loader2 className="size-4 animate-spin" />
            Loading session history...
          </div>
        ) : filteredMessages.length === 0 && !streaming ? (
          <EmptyConversation />
        ) : (
          filteredMessages.map(message => (
            <MessageBlock key={message.id} message={message} onFileClick={setPreviewPath} />
          ))
        )}
        {streaming && <StreamingBlock text={streaming} />}
      </div>

      <div
        className={cn(
          'flex shrink-0 flex-col gap-2 border-t border-[#45475a] bg-[#181825] p-3',
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
          <button
            onClick={handleSend}
            disabled={(!input.trim() && attachments.length === 0) || sending || uploading}
            className="grid h-[42px] w-[48px] shrink-0 place-items-center rounded-md bg-[#cba6f7] font-bold text-[#11111b] transition-opacity disabled:opacity-40"
            title="Send"
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
      </div>

      {previewPath && (
        <DocumentPanel filePath={previewPath} onClose={() => setPreviewPath(null)} />
      )}
    </div>
  )
}

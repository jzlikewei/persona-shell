import { startTransition, useState, useCallback, useEffect, useRef } from 'react'
import { useApi } from './use-api'
import { useWebSocket } from './use-websocket'
import { useToast } from '@/components/toast'
import { mergeChatToolCall, type ChatToolCall } from './chat-tools'
import { uuid } from '@/lib/utils'

export { mergeChatToolCall, type ChatToolCall } from './chat-tools'

export interface ChatWorkflowStep {
  step?: string
  status?: string
}

export interface ChatWorkflowGoal {
  objective?: string
  status?: string
  tokensUsed?: number
  timeUsedSeconds?: number
}

export interface ChatWorkflow {
  turnId: string
  goal?: ChatWorkflowGoal
  plan?: ChatWorkflowStep[]
  explanation?: string | null
  turnStatus?: 'running' | 'completed' | 'failed' | 'aborted' | 'blocked'
}

export type ChatAttachmentKind = 'markdown' | 'text' | 'image' | 'file' | 'audio'

export interface ChatAttachment {
  path: string
  name?: string
  kind?: ChatAttachmentKind
  type?: 'image' | 'file' | 'audio'
  size?: number
  mime?: string
  detail?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  agentContent?: string
  timestamp: string
  sessionId?: string
  agentLabel?: string
  tools?: ChatToolCall[]
  workflow?: ChatWorkflow
  attachments?: ChatAttachment[]
  model?: string
}

export type TurnPhase = 'thinking' | 'streaming' | 'tool_running' | null

export type SendAttachment = ChatAttachment

export interface ChatLiveTurn {
  turnId: string
  text: string
  workflow?: ChatWorkflow | null
  tools: ChatToolCall[]
  phase: TurnPhase
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'blocked'
  startedAt?: string
  updatedAt?: string
  agentLabel?: string
  sessionId?: string | null
}

interface ApiConversationMessage {
  direction: 'in' | 'out'
  content: string
  agentContent?: string
  sessionId?: string
  timestamp?: number
  tools?: ChatToolCall[]
  attachments?: unknown
  model?: string
}

interface AssistantTurnEvent {
  type: 'turn_started' | 'assistant_delta' | 'tool_started' | 'tool_completed' | 'turn_completed' | 'turn_failed' | 'turn_aborted' | 'goal_updated' | 'plan_updated'
  agentLabel: string
  sessionId?: string | null
  turnId: string
  messageId?: string
  timestamp: string
  text?: string
  content?: string
  tool?: ChatToolCall
  goal?: ChatWorkflowGoal
  plan?: ChatWorkflowStep[]
  explanation?: string | null
  durationMs?: number | null
  error?: string
}

interface ApiSessionWorkflow {
  thread?: {
    goal?: ChatWorkflowGoal | null
  }
  turn?: ChatLiveTurn | null
  workflow?: ChatWorkflow | null
  tools?: ChatToolCall[]
  phase?: 'thinking' | 'tool_running' | null
}

function normalizeReplyText(text: string) {
  return text
    .replace(/\n\n\(耗时 [^)]+\)$/u, '')
    .replace(/\n\n\(one-shot [^)]+\)$/u, '')
    .trim()
}

function sameReplyText(a: string, b: string) {
  const left = normalizeReplyText(a)
  const right = normalizeReplyText(b)
  return left === right || left.startsWith(right) || right.startsWith(left)
}

function canonicalUserMessageContent(text: string) {
  return text
    .replace(/^\[(?:\d{4}\/\d{1,2}\/\d{1,2}|\d{4}-\d{1,2}-\d{1,2})\s+\d{1,2}:\d{2}(?::\d{2})?\]\s*/, '')
    .trim()
}

function isDuplicateUserMessage(a: ChatMessage, b: ChatMessage) {
  return a.role === 'user' &&
    b.role === 'user' &&
    a.sessionId === b.sessionId &&
    canonicalUserMessageContent(a.content) === canonicalUserMessageContent(b.content)
}

function mergeAttachments(left?: ChatAttachment[], right?: ChatAttachment[]): ChatAttachment[] | undefined {
  const merged = [...(left ?? [])]
  let changed = false
  for (const item of right ?? []) {
    if (!item.path || merged.some(existing => existing.path === item.path)) continue
    merged.push(item)
    changed = true
  }
  if (!changed && left) return left
  return merged.length ? merged : undefined
}

function appendMessageDedup(prev: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  if (msg.role === 'user') {
    const recent = prev.slice(-20)
    const recentDuplicateIndex = recent.findIndex(existing => isDuplicateUserMessage(existing, msg))
    if (recentDuplicateIndex >= 0) {
      const duplicateIndex = prev.length - recent.length + recentDuplicateIndex
      const existing = prev[duplicateIndex]
      const attachments = mergeAttachments(existing.attachments, msg.attachments)
      const content = canonicalUserMessageContent(existing.content) === msg.content.trim() ? msg.content : existing.content
      if ((attachments === existing.attachments || (!attachments && !existing.attachments)) && content === existing.content) return prev
      return [
        ...prev.slice(0, duplicateIndex),
        { ...existing, content, attachments, agentContent: existing.agentContent ?? msg.agentContent },
        ...prev.slice(duplicateIndex + 1),
      ]
    }
    return [...prev, msg]
  }

  if (msg.role === 'assistant') {
    const last = prev[prev.length - 1]
    if (last?.role === 'assistant' && sameReplyText(last.content, msg.content)) {
      return [...prev.slice(0, -1), { ...last, ...msg, id: last.id, tools: msg.tools ?? last.tools, attachments: mergeAttachments(last.attachments, msg.attachments) }]
    }
  }

  return [...prev, msg]
}

function mergeOptimisticMessages(history: ChatMessage[], optimistic: ChatMessage[]) {
  let next = history
  for (const msg of optimistic) {
    next = appendMessageDedup(next, msg)
  }
  return next
}

function fileNameFromPath(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path
}

function normalizeChatAttachments(value: unknown): ChatAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const attachments = value.flatMap((item): ChatAttachment[] => {
    if (typeof item === 'string') {
      const path = item.trim()
      return path ? [{ path, name: fileNameFromPath(path), kind: 'file' }] : []
    }
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path.trim() : ''
    if (!path) return []
    const rawType = typeof record.type === 'string' ? record.type : undefined
    const rawKind = typeof record.kind === 'string' ? record.kind : undefined
    const type: ChatAttachment['type'] | undefined = rawType === 'image' || rawType === 'audio' || rawType === 'file' ? rawType : undefined
    const kind: ChatAttachmentKind = rawKind === 'markdown' || rawKind === 'text' || rawKind === 'image' || rawKind === 'file' || rawKind === 'audio'
      ? rawKind
      : type ?? 'file'
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : fileNameFromPath(path)
    const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined
    const mime = typeof record.mime === 'string' && record.mime.trim() ? record.mime.trim() : undefined
    const detail = typeof record.detail === 'string' && record.detail.trim() ? record.detail.trim() : undefined
    return [{
      path,
      name,
      kind,
      ...(type ? { type } : {}),
      ...(size != null ? { size } : {}),
      ...(mime ? { mime } : {}),
      ...(detail ? { detail } : {}),
    }]
  })
  return attachments.length ? attachments : undefined
}

function mapMessage(message: ApiConversationMessage, index: number): ChatMessage {
  const timestamp = message.timestamp ? new Date(message.timestamp).toISOString() : new Date().toISOString()
  const isUser = message.direction === 'in'
  const displayContent = isUser ? canonicalUserMessageContent(message.content) : message.content
  return {
    id: `${message.sessionId ?? 'message'}-${message.timestamp ?? Date.now()}-${index}`,
    role: isUser ? 'user' : 'assistant',
    content: displayContent,
    agentContent: message.agentContent ?? (isUser && displayContent !== message.content ? message.content : undefined),
    timestamp,
    sessionId: message.sessionId,
    tools: message.tools,
    attachments: normalizeChatAttachments(message.attachments),
    model: message.model,
  }
}

export function useChat(sessionId?: string, liveSession = false, workspace?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState('')
  const [streamingTools, setStreamingTools] = useState<ChatToolCall[]>([])
  const [workflow, setWorkflow] = useState<ChatWorkflow | null>(null)
  const [threadGoal, setThreadGoal] = useState<ChatWorkflowGoal | null>(null)
  const [currentTurn, setCurrentTurn] = useState<ChatLiveTurn | null>(null)
  const [activity, setActivity] = useState<string | null>(null)
  const [turnPhase, setTurnPhase] = useState<TurnPhase>(null)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  // limit 状态(默认 30;loadMore 调成 500)。后端 /api/messages 不支持 offset/cursor,
  // 所以"Load earlier"只能"调大 limit 重拉最后 N 条",不是真分页。
  const [limit, setLimit] = useState(30)
  // hideMessage 客户端过滤,Set 装被隐藏消息 id
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const { get, post } = useApi()
  const { on, status } = useWebSocket()
  const { toast } = useToast()
  const sessionIdRef = useRef(sessionId)
  const liveSessionRef = useRef(liveSession)
  const requestSeq = useRef(0)
  const streamingRef = useRef('')
  const liveToolsRef = useRef<ChatToolCall[]>([])
  const liveWorkflowRef = useRef<ChatWorkflow | null>(null)
  const currentTurnRef = useRef<ChatLiveTurn | null>(null)
  const liveTurnIdRef = useRef<string | null>(null)
  const usingTurnEventsRef = useRef(false)
  const messageCacheRef = useRef(new Map<string, { at: number; messages: ChatMessage[] }>())
  const optimisticMessagesRef = useRef(new Map<string, ChatMessage[]>())
  const prevHistoryKeyRef = useRef<string | undefined>(undefined)
  sessionIdRef.current = sessionId
  liveSessionRef.current = liveSession

  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const turnPhaseTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const clearTurnPhaseTimeout = useCallback(() => {
    if (turnPhaseTimeoutRef.current) {
      clearTimeout(turnPhaseTimeoutRef.current)
      turnPhaseTimeoutRef.current = undefined
    }
  }, [])

  const armTurnPhaseTimeout = useCallback(() => {
    clearTurnPhaseTimeout()
    turnPhaseTimeoutRef.current = setTimeout(() => {
      setTurnPhase(null)
      turnPhaseTimeoutRef.current = undefined
    }, 600_000)
  }, [clearTurnPhaseTimeout])

  const updateStreaming = useCallback((value: string | ((prev: string) => string)) => {
    setStreaming(prev => {
      const next = typeof value === 'function' ? value(prev) : value
      streamingRef.current = next
      clearTimeout(streamTimeoutRef.current)
      return next
    })
  }, [])

  const publishCurrentTurn = useCallback((turn: ChatLiveTurn | null) => {
    currentTurnRef.current = turn
    setCurrentTurn(turn)
    streamingRef.current = turn?.text ?? ''
    setStreaming(turn?.text ?? '')
    liveToolsRef.current = turn?.tools ?? []
    setStreamingTools(turn?.tools ?? [])
    liveWorkflowRef.current = turn?.workflow ?? null
    setWorkflow(turn?.workflow ?? null)
    setTurnPhase(turn?.phase ?? null)
    setActivity(turn?.tools?.find(tool => tool.status === 'running')?.name ?? null)
  }, [])

  const patchCurrentTurn = useCallback((patch: Partial<ChatLiveTurn> & { turnId: string }) => {
    const previous = currentTurnRef.current?.turnId === patch.turnId ? currentTurnRef.current : null
    const next: ChatLiveTurn = {
      turnId: patch.turnId,
      text: patch.text ?? previous?.text ?? '',
      workflow: patch.workflow !== undefined ? patch.workflow : previous?.workflow ?? null,
      tools: patch.tools ?? previous?.tools ?? [],
      phase: patch.phase !== undefined ? patch.phase : previous?.phase ?? 'thinking',
      status: patch.status ?? previous?.status ?? 'running',
      startedAt: previous?.startedAt ?? patch.startedAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
      agentLabel: patch.agentLabel ?? previous?.agentLabel,
      sessionId: patch.sessionId ?? previous?.sessionId,
    }
    publishCurrentTurn(next)
    return next
  }, [publishCurrentTurn])

  const liveEventMatches = useCallback((data: Record<string, unknown>) => {
    const eventSessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : undefined
    const selectedSessionId = sessionIdRef.current
    if (!selectedSessionId) return false
    if (selectedSessionId && eventSessionId && eventSessionId !== selectedSessionId) {
      return false
    }
    if (selectedSessionId && !eventSessionId && !liveSessionRef.current) return false
    return true
  }, [])

  const loadWorkflowSnapshot = useCallback(async (targetSessionId: string, seq: number) => {
    try {
      const live = await get<ApiSessionWorkflow>('/api/session-workflow', { sessionId: targetSessionId })
      if (seq !== requestSeq.current) return
      const goal = live.thread?.goal ?? live.workflow?.goal ?? null
      setThreadGoal(goal)
      if (live.turn) {
        const hydratedTurn: ChatLiveTurn = {
          ...live.turn,
          workflow: live.turn.workflow ? { ...live.turn.workflow, goal: undefined } : null,
          tools: live.turn.tools ?? [],
          phase: live.turn.phase ?? null,
        }
        liveTurnIdRef.current = hydratedTurn.turnId
        publishCurrentTurn(hydratedTurn)
      } else {
        const liveTools = live.tools ?? []
        const liveTurnWorkflow = live.workflow && (live.workflow.plan?.length || live.workflow.explanation || live.phase || liveTools.length > 0)
          ? { ...live.workflow, goal: undefined }
          : null
        if (liveTurnWorkflow || live.phase || liveTools.length > 0) {
          const syntheticTurnId = liveTurnWorkflow?.turnId ?? 'live'
          liveTurnIdRef.current = syntheticTurnId
          publishCurrentTurn({
            turnId: syntheticTurnId,
            text: '',
            workflow: liveTurnWorkflow,
            tools: liveTools,
            phase: live.phase ?? 'thinking',
            status: 'running',
          })
        } else {
          liveTurnIdRef.current = null
          publishCurrentTurn(null)
        }
      }
    } catch {
      // 老后端或非 live session 没有 workflow snapshot 时忽略。
    }
  }, [get, publishCurrentTurn])

  const loadMessages = useCallback(async () => {
    if (!sessionId) {
      setMessages([])
      setLoading(false)
      return
    }

    const seq = requestSeq.current + 1
    requestSeq.current = seq
    const cacheKey = `${workspace ?? ''}:${sessionId}:${limit}`
    const cached = messageCacheRef.current.get(cacheKey)
    if (cached) {
      const targetOptimistic = optimisticMessagesRef.current.get(sessionId) ?? []
      startTransition(() => setMessages(mergeOptimisticMessages(cached.messages, targetOptimistic)))
      // 切换 session 时最卡的是后端重复解析原生 transcript。短 TTL 内直接复用
      // 已解析窗口；实时消息会由 websocket 继续补齐。
      if (Date.now() - cached.at < 15_000) {
        await loadWorkflowSnapshot(sessionId, seq)
        setLoading(false)
        return
      }
    }

    setLoading(true)
    try {
      const params: Record<string, string> = { limit: String(limit), sessionId }
      if (workspace) params.workspace = workspace
      const data = await get<ApiConversationMessage[]>('/api/messages', params)
      if (seq === requestSeq.current) {
        const targetOptimistic = optimisticMessagesRef.current.get(sessionId) ?? []
        const next = mergeOptimisticMessages(data.map(mapMessage).reverse(), targetOptimistic)
        messageCacheRef.current.set(cacheKey, { at: Date.now(), messages: next })
        // 大列表 + 同步 markdown 渲染会堵主线程,startTransition 让它走低优先级,
        // 不阻塞 loading spinner 绘制和后续用户输入(比如再点别的 session)
        startTransition(() => setMessages(next))
        await loadWorkflowSnapshot(sessionId, seq)
      }
    } catch (e) {
      console.error('Failed to load messages:', e)
      toast({ title: '加载消息失败', description: e instanceof Error ? e.message : String(e), tone: 'error' })
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [get, loadWorkflowSnapshot, sessionId, workspace, limit, toast])

  // "Load earlier" 只能调大 limit 重新拉窗口
  const loadMore = useCallback(() => {
    setLimit(500)
  }, [])

  // hideMessage / showMessage / showAllHidden 客户端过滤,可逆
  const hideMessage = useCallback((id: string) => {
    setHiddenIds(prev => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])
  const showMessage = useCallback((id: string) => {
    setHiddenIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])
  const showAllHidden = useCallback(() => {
    setHiddenIds(new Set())
  }, [])

  const flushStreaming = useCallback(() => {
    const text = streamingRef.current
    if (!text) return
    clearTimeout(streamTimeoutRef.current)
    streamingRef.current = ''
    setStreaming('')
    setMessages(prev => {
      const last = prev[prev.length - 1]
      if (last?.role === 'assistant' && sameReplyText(last.content, text)) return prev
      return [...prev, {
        id: uuid(),
        role: 'assistant' as const,
        content: text,
        timestamp: new Date().toISOString(),
        sessionId: sessionIdRef.current,
      }]
    })
  }, [])

  const upsertLiveTool = useCallback((tool: ChatToolCall) => {
    const tools = mergeChatToolCall(liveToolsRef.current, tool)
    liveToolsRef.current = tools
    setStreamingTools(tools)
    setActivity(tool.name || 'tool')
  }, [])

  const clearLiveTurn = useCallback(() => {
    liveTurnIdRef.current = null
    publishCurrentTurn(null)
    setActivity(null)
    clearTurnPhaseTimeout()
  }, [publishCurrentTurn, clearTurnPhaseTimeout])

  const sendMessage = useCallback(async (content: string, onSessionCreated?: (sessionId: string) => void, attachments: SendAttachment[] = []) => {
    if (!usingTurnEventsRef.current) flushStreaming()
    setSending(true)
    let targetSessionId = sessionId
    try {
      if (!targetSessionId) {
        const created = await post<{ ok: boolean; sessionId?: string; error?: string }>(
          '/api/sessions',
          { workspace: workspace || 'main' }
        )
        if (!created.ok || !created.sessionId) {
          throw new Error(created.error || 'failed to create session')
        }
        targetSessionId = created.sessionId
        onSessionCreated?.(targetSessionId)
      }
    } catch (e) {
      console.error('Failed to create session:', e)
      toast({ title: '新建 Session 失败', description: e instanceof Error ? e.message : String(e), tone: 'error' })
      setMessages(prev => [...prev, {
        id: uuid(),
        role: 'assistant',
        content: `[系统] 新建 session 失败: ${e instanceof Error ? e.message : String(e)}`,
        timestamp: new Date().toISOString(),
        sessionId,
      }])
      setSending(false)
      return
    }

    const userMsg: ChatMessage = {
      id: uuid(),
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      sessionId: targetSessionId,
      attachments: attachments.length ? normalizeChatAttachments(attachments) : undefined,
    }
    optimisticMessagesRef.current.set(targetSessionId, appendMessageDedup(optimisticMessagesRef.current.get(targetSessionId) ?? [], userMsg))
    setMessages(prev => appendMessageDedup(prev, userMsg))

    try {
      await post('/api/send', {
        text: content,
        sessionId: targetSessionId,
        attachments,
      })
    } catch (e) {
      console.error('Failed to send message:', e)
      toast({ title: '消息发送失败', description: e instanceof Error ? e.message : String(e), tone: 'error' })
      const errMsg: ChatMessage = {
        id: uuid(),
        role: 'assistant',
        content: `[系统] 消息发送失败: ${e instanceof Error ? e.message : String(e)}`,
        timestamp: new Date().toISOString(),
        sessionId: targetSessionId,
      }
      setMessages(prev => [...prev, errMsg])
    } finally {
      setSending(false)
    }
  }, [post, sessionId, workspace, flushStreaming, toast])

  useEffect(() => {
    const unsubs = [
      on('turn_event', (data) => {
        const event = data.event as AssistantTurnEvent | undefined
        if (!event || !liveEventMatches(event as unknown as Record<string, unknown>)) return
        usingTurnEventsRef.current = true

        if (event.type === 'turn_started') {
          liveTurnIdRef.current = event.turnId
          publishCurrentTurn({
            turnId: event.turnId,
            text: '',
            workflow: null,
            tools: [],
            phase: 'thinking',
            status: 'running',
            startedAt: event.timestamp,
            updatedAt: event.timestamp,
            agentLabel: event.agentLabel,
            sessionId: event.sessionId,
          })
          setActivity(null)
          armTurnPhaseTimeout()
          return
        }

        if (event.type === 'goal_updated') {
          setThreadGoal(event.goal ?? null)
          return
        }

        if (liveTurnIdRef.current !== event.turnId) {
          liveTurnIdRef.current = event.turnId
          publishCurrentTurn({
            turnId: event.turnId,
            text: '',
            workflow: null,
            tools: [],
            phase: 'thinking',
            status: 'running',
            startedAt: event.timestamp,
            updatedAt: event.timestamp,
            agentLabel: event.agentLabel,
            sessionId: event.sessionId,
          })
        }

        if (event.type === 'plan_updated') {
          const next: ChatWorkflow = {
            ...(liveWorkflowRef.current ?? { turnId: event.turnId }),
            turnId: event.turnId,
            plan: event.plan,
            explanation: event.explanation,
            turnStatus: 'running',
          }
          liveWorkflowRef.current = next
          patchCurrentTurn({
            turnId: event.turnId,
            workflow: next,
            phase: currentTurnRef.current?.text ? 'streaming' : currentTurnRef.current?.tools?.some(tool => tool.status === 'running') ? 'tool_running' : 'thinking',
            status: 'running',
            updatedAt: event.timestamp,
            agentLabel: event.agentLabel,
            sessionId: event.sessionId,
          })
          armTurnPhaseTimeout()
          return
        }

        if (event.type === 'assistant_delta') {
          const text = (currentTurnRef.current?.turnId === event.turnId ? currentTurnRef.current.text : '') + (event.text ?? '')
          patchCurrentTurn({
            turnId: event.turnId,
            text,
            phase: 'streaming',
            status: 'running',
            updatedAt: event.timestamp,
            agentLabel: event.agentLabel,
            sessionId: event.sessionId,
          })
          armTurnPhaseTimeout()
          return
        }

        if (event.type === 'tool_started') {
          if (event.tool) upsertLiveTool(event.tool)
          patchCurrentTurn({
            turnId: event.turnId,
            tools: liveToolsRef.current,
            phase: 'tool_running',
            status: 'running',
            updatedAt: event.timestamp,
            agentLabel: event.agentLabel,
            sessionId: event.sessionId,
          })
          armTurnPhaseTimeout()
          return
        }

        if (event.type === 'tool_completed') {
          if (event.tool) {
            upsertLiveTool(event.tool)
            const hasRunningTool = liveToolsRef.current.some(tool => tool.status === 'running')
            patchCurrentTurn({
              turnId: event.turnId,
              tools: liveToolsRef.current,
              phase: hasRunningTool ? 'tool_running' : (streamingRef.current ? 'streaming' : liveWorkflowRef.current?.plan?.length ? 'thinking' : null),
              status: 'running',
              updatedAt: event.timestamp,
              agentLabel: event.agentLabel,
              sessionId: event.sessionId,
            })
          }
          armTurnPhaseTimeout()
          return
        }

        if (event.type === 'turn_completed') {
          const text = event.content ?? currentTurnRef.current?.text ?? streamingRef.current
          const tools = liveToolsRef.current.map(t =>
            t.status === 'running' ? { ...t, status: 'completed' as const } : t
          )
          if (text || tools.length) {
            const msg: ChatMessage = {
              id: event.messageId || event.turnId,
              role: 'assistant',
              content: text,
              timestamp: event.timestamp || new Date().toISOString(),
              agentLabel: event.agentLabel,
              sessionId: event.sessionId ?? undefined,
              tools: tools.length ? tools : undefined,
            }
            setMessages(prev => appendMessageDedup(prev, msg))
          }
          clearLiveTurn()
          return
        }

        if (event.type === 'turn_failed') {
          const msg: ChatMessage = {
            id: event.messageId || event.turnId,
            role: 'assistant',
            content: event.error ? `处理失败：${event.error}` : '处理失败，请稍后重试',
            timestamp: event.timestamp || new Date().toISOString(),
            agentLabel: event.agentLabel,
            sessionId: event.sessionId ?? undefined,
          }
          setMessages(prev => [...prev, msg])
          clearLiveTurn()
          return
        }

        if (event.type === 'turn_aborted') {
          clearLiveTurn()
        }
      }),
      on('chunk', (data) => {
        if (usingTurnEventsRef.current) return
        if (!liveEventMatches(data)) return
        updateStreaming(prev => prev + (data.text as string || ''))
      }),
      on('tool-call', (data) => {
        if (usingTurnEventsRef.current) return
        if (!liveEventMatches(data)) return
        const eventTool = data.tool as ChatToolCall | undefined
        const toolName = typeof data.toolName === 'string' && data.toolName ? data.toolName : eventTool?.name || 'tool'
        upsertLiveTool(eventTool ?? { id: uuid(), name: toolName, timestamp: Date.now(), status: 'running' })
      }),
      on('stream-abort', (data) => {
        if (usingTurnEventsRef.current) return
        if (!liveEventMatches(data)) return
        clearLiveTurn()
      }),
      on('chat_reply', (data) => {
        if (usingTurnEventsRef.current) return
        if (!liveEventMatches(data)) return
        const replySessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : sessionIdRef.current
        const text = data.text as string || ''
        const liveTools = liveToolsRef.current.map(t =>
          t.status === 'running' ? { ...t, status: 'completed' as const } : t
        )
        const msg: ChatMessage = {
          id: data.messageId as string || uuid(),
          role: 'assistant',
          content: text,
          timestamp: new Date().toISOString(),
          sessionId: replySessionId,
          tools: liveTools.length ? liveTools : undefined,
          attachments: normalizeChatAttachments(data.attachments),
        }
        setMessages(prev => appendMessageDedup(prev, msg))
        if (!streamingRef.current || sameReplyText(streamingRef.current, text)) updateStreaming('')
        else updateStreaming('')
        clearLiveTurn()
      }),
      on('chat_input', (data) => {
        if (!liveEventMatches(data)) return
        const inputSessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : sessionIdRef.current
        const text = data.text as string || ''
        const msg: ChatMessage = {
          id: data.messageId as string || uuid(),
          role: 'user',
          content: text,
          timestamp: typeof data.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
          sessionId: inputSessionId,
          attachments: normalizeChatAttachments(data.attachments),
        }
        if (inputSessionId) {
          optimisticMessagesRef.current.set(
            inputSessionId,
            (optimisticMessagesRef.current.get(inputSessionId) ?? []).filter(existing => !isDuplicateUserMessage(existing, msg)),
          )
        }
        setMessages(prev => appendMessageDedup(prev, msg))
      }),
    ]
    return () => unsubs.forEach(fn => fn())
  }, [armTurnPhaseTimeout, clearLiveTurn, liveEventMatches, on, patchCurrentTurn, publishCurrentTurn, updateStreaming, upsertLiveTool])

  useEffect(() => {
    return () => clearTurnPhaseTimeout()
  }, [clearTurnPhaseTimeout])

  useEffect(() => {
    const historyKey = `${workspace ?? ''}:${sessionId ?? ''}`
    const switchedHistory = prevHistoryKeyRef.current !== historyKey
    prevHistoryKeyRef.current = historyKey

    if (switchedHistory) {
      setMessages([])
      publishCurrentTurn(null)
      setActivity(null)
      clearTurnPhaseTimeout()
      liveTurnIdRef.current = null
      usingTurnEventsRef.current = false
    }

    if (status === 'connected') loadMessages()
  }, [sessionId, workspace, status, loadMessages, publishCurrentTurn, clearTurnPhaseTimeout])

  return { messages, streaming, streamingTools, workflow, currentTurn, threadGoal, activity, turnPhase, loading, sending, sendMessage, loadMessages, loadMore, hiddenIds, hideMessage, showMessage, showAllHidden }
}

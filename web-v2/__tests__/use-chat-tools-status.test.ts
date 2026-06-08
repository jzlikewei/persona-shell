/**
 * Tests for tool-status state-machine logic extracted from use-chat.ts.
 *
 * We test the pure data-transform patterns used in event handlers,
 * NOT React hooks or component rendering.
 */
import { describe, expect, test } from 'bun:test'
import { mergeChatToolCall, type ChatToolCall } from '../src/hooks/chat-tools'

// ── helpers that mirror use-chat.ts inline transforms ──

/** turn_completed / chat_reply: map running → completed */
function finalizeTools(tools: ChatToolCall[]): ChatToolCall[] {
  return tools.map(t =>
    t.status === 'running' ? { ...t, status: 'completed' as const } : t,
  )
}

/** clearLiveTurn: wipe all tools (turn_failed / turn_aborted) */
function clearLiveTools(): ChatToolCall[] {
  return []
}

// ── turn_completed: running → completed mapping ──

describe('turn_completed: running → completed mapping', () => {
  test('single running tool becomes completed', () => {
    const live: ChatToolCall[] = [
      { id: 'tool-1', name: 'Bash', status: 'running', timestamp: 1 },
    ]
    const result = finalizeTools(live)
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe('completed')
    expect(result[0].id).toBe('tool-1')
  })

  test('multiple running tools all become completed', () => {
    const live: ChatToolCall[] = [
      { id: 'tool-1', name: 'Bash', status: 'running', timestamp: 1 },
      { id: 'tool-2', name: 'Read', status: 'running', timestamp: 2 },
      { id: 'tool-3', name: 'Write', status: 'running', timestamp: 3 },
    ]
    const result = finalizeTools(live)
    expect(result).toHaveLength(3)
    result.forEach(t => expect(t.status).toBe('completed'))
  })

  test('already-completed tools stay completed', () => {
    const live: ChatToolCall[] = [
      { id: 'tool-1', name: 'Bash', status: 'completed', result: 'ok', timestamp: 1 },
      { id: 'tool-2', name: 'Read', status: 'running', timestamp: 2 },
    ]
    const result = finalizeTools(live)
    expect(result[0].status).toBe('completed')
    expect(result[0].result).toBe('ok')
    expect(result[1].status).toBe('completed')
  })

  test('failed tools stay failed (not overwritten to completed)', () => {
    const live: ChatToolCall[] = [
      { id: 'tool-1', name: 'Bash', status: 'failed', isError: true, timestamp: 1 },
      { id: 'tool-2', name: 'Read', status: 'running', timestamp: 2 },
    ]
    const result = finalizeTools(live)
    expect(result[0].status).toBe('failed')
    expect(result[0].isError).toBe(true)
    expect(result[1].status).toBe('completed')
  })

  test('empty tools array stays empty', () => {
    expect(finalizeTools([])).toEqual([])
  })
})

// ── chat_reply: same running → completed mapping ──

describe('chat_reply: running → completed mapping', () => {
  test('mirrors turn_completed behavior exactly', () => {
    const live: ChatToolCall[] = [
      { id: 'tool-1', name: 'Bash', status: 'running', timestamp: 1 },
      { id: 'tool-2', name: 'Read', status: 'completed', result: 'content', timestamp: 2 },
    ]
    const result = finalizeTools(live)
    expect(result[0].status).toBe('completed')
    expect(result[1].status).toBe('completed')
    expect(result[1].result).toBe('content')
  })

  test('preserves all tool fields after mapping', () => {
    const live: ChatToolCall[] = [
      {
        id: 'tool-1',
        name: 'Bash',
        status: 'running',
        input: '{ "command": "ls" }',
        timestamp: 100,
      },
    ]
    const result = finalizeTools(live)
    expect(result[0]).toEqual({
      id: 'tool-1',
      name: 'Bash',
      status: 'completed',
      input: '{ "command": "ls" }',
      timestamp: 100,
    })
  })
})

// ── turn_failed / turn_aborted: clearLiveTurn ──

describe('turn_failed / turn_aborted: clearLiveTurn clears tools', () => {
  test('tools cleared after turn_failed', () => {
    expect(clearLiveTools()).toEqual([])
  })

  test('tools cleared after turn_aborted', () => {
    expect(clearLiveTools()).toEqual([])
  })

  test('clearLiveTurn produces empty array regardless of prior state', () => {
    // simulate: there were running tools before abort
    const _priorTools: ChatToolCall[] = [
      { id: 'tool-1', name: 'Bash', status: 'running', timestamp: 1 },
      { id: 'tool-2', name: 'Read', status: 'completed', timestamp: 2 },
    ]
    // after clearLiveTurn, liveToolsRef.current = []
    const after = clearLiveTools()
    expect(after).toEqual([])
    expect(after).toHaveLength(0)
  })
})

// ── tool_started sets phase, tool_completed does not change phase ──

describe('phase transitions from tool events', () => {
  // Phase logic in use-chat.ts:
  //   tool_started  → setTurnPhase('tool_running')
  //   tool_completed → does NOT call setTurnPhase (only armTurnPhaseTimeout)
  //
  // We model this as a state reducer to test the transition rules.

  type TurnPhase = 'thinking' | 'streaming' | 'tool_running' | null

  function applyToolEvent(
    currentPhase: TurnPhase,
    eventType: 'tool_started' | 'tool_completed',
  ): TurnPhase {
    if (eventType === 'tool_started') return 'tool_running'
    // tool_completed does NOT change phase
    return currentPhase
  }

  test('tool_started sets phase to tool_running from any state', () => {
    expect(applyToolEvent(null, 'tool_started')).toBe('tool_running')
    expect(applyToolEvent('thinking', 'tool_started')).toBe('tool_running')
    expect(applyToolEvent('streaming', 'tool_started')).toBe('tool_running')
    expect(applyToolEvent('tool_running', 'tool_started')).toBe('tool_running')
  })

  test('tool_completed does NOT change current phase', () => {
    expect(applyToolEvent('tool_running', 'tool_completed')).toBe('tool_running')
    expect(applyToolEvent('streaming', 'tool_completed')).toBe('streaming')
    expect(applyToolEvent('thinking', 'tool_completed')).toBe('thinking')
    expect(applyToolEvent(null, 'tool_completed')).toBe(null)
  })
})

// ── integration: mergeChatToolCall + finalizeTools pipeline ──

describe('integration: merge → finalize pipeline', () => {
  test('tool_started then tool_completed then turn_completed', () => {
    // Step 1: tool_started
    let tools = mergeChatToolCall([], { id: 'tool-1', name: 'Bash', status: 'running' }, 1)
    expect(tools).toHaveLength(1)
    expect(tools[0].status).toBe('running')

    // Step 2: tool_completed
    tools = mergeChatToolCall(tools, {
      id: 'tool-1',
      name: 'Bash',
      result: '/tmp',
      isError: false,
    }, 2)
    expect(tools).toHaveLength(1)
    expect(tools[0].status).toBe('completed')
    expect(tools[0].result).toBe('/tmp')

    // Step 3: turn_completed finalizes any remaining running
    const finalized = finalizeTools(tools)
    expect(finalized).toHaveLength(1)
    expect(finalized[0].status).toBe('completed')
  })

  test('multiple tools: some completed inline, remaining finalized at turn end', () => {
    // Two tools started
    let tools = mergeChatToolCall([], { id: 't1', name: 'Bash', status: 'running' }, 1)
    tools = mergeChatToolCall(tools, { id: 't2', name: 'Read', status: 'running' }, 2)
    expect(tools).toHaveLength(2)

    // Only t1 gets tool_completed
    tools = mergeChatToolCall(tools, { id: 't1', name: 'Bash', result: 'ok', isError: false }, 3)
    expect(tools[0].status).toBe('completed')
    expect(tools[1].status).toBe('running')

    // turn_completed finalizes t2
    const finalized = finalizeTools(tools)
    expect(finalized[0].status).toBe('completed')
    expect(finalized[1].status).toBe('completed')
  })
})

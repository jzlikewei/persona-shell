/**
 * codex-transcript-reader.ts — Codex CLI 原生 session transcript 解析
 *
 * 读取 ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl，
 * 返回与 log-parser.ts 相同的 ConversationMessage[] 格式。
 */

import { existsSync, statSync, readdirSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { splitUserMessageContent, type ConversationMessage, type ConversationToolCall } from './log-parser.js';

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024; // 4MB
const CODEX_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

type TranscriptCacheEntry = {
  filePath: string;
  size: number;
  mtimeMs: number;
  messages: ConversationMessage[];
};

const transcriptPathCache = new Map<string, string | null>();
const transcriptParseCache = new Map<string, TranscriptCacheEntry>();

// ---------------------------------------------------------------------------
// File discovery — find the transcript file for a given sessionId (thread-id)
// ---------------------------------------------------------------------------

/**
 * Recursively search ~/.codex/sessions/ for a .jsonl file whose name contains
 * the given sessionId (which is the Codex thread-id embedded in the filename).
 */
function findTranscriptFile(sessionId: string, sessionsDir = CODEX_SESSIONS_DIR): string | null {
  const cacheKey = `${sessionsDir}:${sessionId}`;
  if (transcriptPathCache.has(cacheKey)) {
    const cached = transcriptPathCache.get(cacheKey) ?? null;
    if (!cached || existsSync(cached)) return cached;
    transcriptPathCache.delete(cacheKey);
  }

  if (!existsSync(sessionsDir)) return null;

  // Walk YYYY/MM/DD directories
  try {
    for (const year of readdirSync(sessionsDir)) {
      const yearDir = join(sessionsDir, year);
      if (!statSync(yearDir).isDirectory()) continue;
      for (const month of readdirSync(yearDir)) {
        const monthDir = join(yearDir, month);
        if (!statSync(monthDir).isDirectory()) continue;
        for (const day of readdirSync(monthDir)) {
          const dayDir = join(monthDir, day);
          if (!statSync(dayDir).isDirectory()) continue;
          for (const file of readdirSync(dayDir)) {
            if (file.endsWith('.jsonl') && file.includes(sessionId)) {
              const found = join(dayDir, file);
              transcriptPathCache.set(cacheKey, found);
              return found;
            }
          }
        }
      }
    }
  } catch {
    // Permission errors, etc.
  }
  transcriptPathCache.set(cacheKey, null);
  return null;
}

// ---------------------------------------------------------------------------
// File reading (tail-read, same pattern as claude-transcript-reader)
// ---------------------------------------------------------------------------

function readTail(filePath: string, maxBytes: number): string {
  if (!existsSync(filePath)) return '';
  const stat = statSync(filePath);
  if (stat.size === 0) return '';
  const readSize = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(readSize);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buf, 0, readSize, stat.size - readSize);
  } finally {
    closeSync(fd);
  }
  const raw = buf.toString('utf-8');
  if (readSize < stat.size) {
    const firstNewline = raw.indexOf('\n');
    return firstNewline >= 0 ? raw.slice(firstNewline + 1) : '';
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function stringifyPreview(value: unknown, maxLength = 900): string | undefined {
  if (value == null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) + '…' : trimmed;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

type TurnAccum = {
  turnId: string;
  userText?: string;
  userAgentText?: string;
  userTimestamp?: string;
  assistantTexts: string[];
  tools: ConversationToolCall[];
  model?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * Parse a Codex CLI native session transcript (.jsonl) into ConversationMessage[].
 * Returns null if the transcript file does not exist (caller should fall back to pShell logs).
 */
export function parseCodexTranscript(
  sessionId: string,
  limit: number,
  sessionsDir?: string,
): ConversationMessage[] | null {
  const filePath = findTranscriptFile(sessionId, sessionsDir);
  if (!filePath) return null;

  const stat = statSync(filePath);
  const cacheKey = `${sessionId}:${filePath}`;
  const cached = transcriptParseCache.get(cacheKey);
  if (cached && cached.filePath === filePath && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.messages.length ? cached.messages.slice(-limit).reverse() : null;
  }

  const raw = readTail(filePath, MAX_TRANSCRIPT_BYTES);
  if (!raw.trim()) return null;

  // Track tool call outputs by call_id
  const toolOutputs = new Map<string, { output: string; isError: boolean }>();

  // Collect turns separated by task_complete events
  const turns: TurnAccum[] = [];
  let currentTurn: TurnAccum | null = null;

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(line); } catch { continue; }

    const type = evt.type as string;
    const payload = evt.payload as Record<string, unknown> | undefined;
    if (!payload) continue;

    const payloadType = payload.type as string | undefined;
    const timestamp = evt.timestamp as string | undefined;

    // --- task_started: begin a new turn ---
    if (type === 'event_msg' && payloadType === 'task_started') {
      const turnId = payload.turn_id as string ?? '';
      currentTurn = {
        turnId,
        assistantTexts: [],
        tools: [],
        firstTimestamp: timestamp,
      };
      turns.push(currentTurn);
      continue;
    }

    // --- task_complete: finalize current turn ---
    if (type === 'event_msg' && payloadType === 'task_complete') {
      if (currentTurn && timestamp) {
        currentTurn.lastTimestamp = timestamp;
      }
      // Attach tool outputs to tool calls
      if (currentTurn) {
        for (const tool of currentTurn.tools) {
          if (tool.id) {
            const output = toolOutputs.get(tool.id);
            if (output) {
              tool.result = output.output;
              tool.isError = output.isError;
            }
          }
        }
      }
      currentTurn = null;
      continue;
    }

    if (!currentTurn) continue;

    // --- response_item with role=user, type=message: user message ---
    if (type === 'response_item' && payloadType === 'message') {
      const role = payload.role as string | undefined;
      const content = payload.content as Array<Record<string, unknown>> | undefined;
      if (!content || !Array.isArray(content)) continue;

      if (role === 'user') {
        // Extract text from user message; skip developer/system messages
        for (const block of content) {
          if (block.type === 'input_text') {
            const text = (block.text as string ?? '').trim();
            // Skip system prompts (AGENTS.md, permissions, env context, etc.)
            if (text.startsWith('<') || text.startsWith('#')) continue;
            if (text) {
              const split = splitUserMessageContent(text);
              currentTurn.userText = split.content;
              currentTurn.userAgentText = split.agentContent;
              currentTurn.userTimestamp = timestamp;
            }
          }
        }
        continue;
      }

      if (role === 'assistant') {
        // Extract assistant text from output_text blocks
        for (const block of content) {
          if (block.type === 'output_text') {
            const text = (block.text as string ?? '').trim();
            if (text) currentTurn.assistantTexts.push(text);
          }
        }
        continue;
      }

      // Skip developer messages
      continue;
    }

    // --- response_item type=function_call: tool invocation ---
    if (type === 'response_item' && payloadType === 'function_call') {
      const callId = payload.call_id as string | undefined;
      const name = payload.name as string ?? 'tool';
      const args = payload.arguments as string | undefined;
      currentTurn.tools.push({
        id: callId,
        name,
        input: stringifyPreview(args),
        timestamp: timestamp ? new Date(timestamp).getTime() : undefined,
      });
      continue;
    }

    // --- response_item type=function_call_output: tool result ---
    if (type === 'response_item' && payloadType === 'function_call_output') {
      const callId = payload.call_id as string | undefined;
      const output = payload.output as string | undefined;
      if (callId) {
        toolOutputs.set(callId, {
          output: stringifyPreview(output, 1200) ?? '',
          isError: false,
        });
      }
      continue;
    }

    // --- event_msg type=agent_message: streamed assistant text ---
    // These often duplicate the final response_item message; prefer response_item.
    // We only use agent_message if no response_item assistant message was seen.

    // --- event_msg type=token_count: usage info ---
    if (type === 'event_msg' && payloadType === 'token_count') {
      const info = payload.info as Record<string, unknown> | undefined;
      if (info) {
        const lastUsage = info.last_token_usage as Record<string, number> | undefined;
        if (lastUsage) {
          currentTurn.inputTokens = (currentTurn.inputTokens ?? 0)
            + (lastUsage.input_tokens ?? 0);
          currentTurn.outputTokens = (currentTurn.outputTokens ?? 0)
            + (lastUsage.output_tokens ?? 0)
            + (lastUsage.reasoning_output_tokens ?? 0);
        }
      }
      continue;
    }

    // Skip: reasoning, turn_context, session_meta, etc.
  }

  // Build ConversationMessage[] from turns
  const messages: ConversationMessage[] = [];

  for (const turn of turns) {
    // User message
    if (turn.userText) {
      messages.push({
        direction: 'in',
        content: turn.userText,
        agentContent: turn.userAgentText,
        sessionId,
        timestamp: turn.userTimestamp ? new Date(turn.userTimestamp).getTime() : undefined,
      });
    }

    // Assistant message (merge all text + tools in this turn)
    const assistantContent = turn.assistantTexts.join('\n\n');
    if (assistantContent || turn.tools.length > 0) {
      const inputTokens = turn.inputTokens;
      const outputTokens = turn.outputTokens;
      messages.push({
        direction: 'out',
        content: assistantContent || '',
        sessionId,
        timestamp: turn.lastTimestamp
          ? new Date(turn.lastTimestamp).getTime()
          : turn.firstTimestamp
            ? new Date(turn.firstTimestamp).getTime()
            : undefined,
        tools: turn.tools.length ? turn.tools : undefined,
        provider: 'codex',
        model: turn.model,
        inputTokens,
        outputTokens,
        tokens: inputTokens != null || outputTokens != null
          ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined,
      });
    }
  }

  transcriptParseCache.set(`${sessionId}:${filePath}`, {
    filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    messages,
  });
  return messages.length ? messages.slice(-limit).reverse() : null;
}

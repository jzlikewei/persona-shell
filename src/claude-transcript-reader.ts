/**
 * claude-transcript-reader.ts — Claude Code 原生 session transcript 解析
 *
 * 读取 ~/.claude/projects/<encoded-path>/<sessionId>.jsonl，
 * 返回与 log-parser.ts 相同的 ConversationMessage[] 格式。
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ConversationMessage, ConversationToolCall } from './log-parser.js';

const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024; // 4MB

type TranscriptCacheEntry = {
  filePath: string;
  size: number;
  mtimeMs: number;
  messages: ConversationMessage[];
};

const transcriptParseCache = new Map<string, TranscriptCacheEntry>();

// ---------------------------------------------------------------------------
// Path encoding
// ---------------------------------------------------------------------------

/** Encode a filesystem path to Claude Code's project directory name.
 *  Rule: replace every char not in [a-zA-Z0-9_-] with a single '-'. */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function resolveTranscriptPath(sessionId: string, cwd: string): string {
  const encoded = encodeProjectPath(cwd);
  const home = process.env.HOME ?? homedir();
  return join(home, '.claude', 'projects', encoded, `${sessionId}.jsonl`);
}

// ---------------------------------------------------------------------------
// File reading (tail-read, same pattern as log-parser)
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

function extractToolResultText(value: unknown): string | undefined {
  if (typeof value === 'string') return stringifyPreview(value, 1200);
  if (!Array.isArray(value)) return stringifyPreview(value, 1200);
  const parts: string[] = [];
  for (const block of value) {
    if (typeof block === 'object' && block) {
      const item = block as Record<string, unknown>;
      if (typeof item.content === 'string') parts.push(item.content);
      else if (typeof item.text === 'string') parts.push(item.text);
    }
  }
  return parts.length ? stringifyPreview(parts.join('\n'), 1200) : undefined;
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

type AssistantAccum = {
  texts: string[];
  tools: ConversationToolCall[];
  model?: string;
  timestamp?: string;
  inputTokens?: number;
  outputTokens?: number;
};

/**
 * Parse a Claude Code native session transcript (.jsonl) into ConversationMessage[].
 * Returns null if the transcript file does not exist (caller should fall back to pShell logs).
 */
export function parseClaudeTranscript(
  sessionId: string,
  cwd: string,
  limit: number,
): ConversationMessage[] | null {
  const filePath = resolveTranscriptPath(sessionId, cwd);
  if (!existsSync(filePath)) return null;

  const stat = statSync(filePath);
  const cacheKey = `${sessionId}:${cwd}:${filePath}`;
  const cached = transcriptParseCache.get(cacheKey);
  if (cached && cached.filePath === filePath && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.messages.slice(-limit).reverse();
  }

  const raw = readTail(filePath, MAX_TRANSCRIPT_BYTES);
  if (!raw.trim()) return null;

  // Phase 1: Parse lines
  const userMessages: ConversationMessage[] = [];
  const assistantTurns = new Map<string, AssistantAccum>();
  const toolResults = new Map<string, { result: string; isError: boolean }>();

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(line); } catch { continue; }

    // --- User messages ---
    if (evt.type === 'user') {
      const msg = evt.message as Record<string, unknown> | undefined;
      if (msg?.role !== 'user') continue;
      const content = msg.content;

      // Plain text prompt → direction: 'in'
      if (typeof content === 'string') {
        userMessages.push({
          direction: 'in',
          content,
          sessionId: typeof evt.sessionId === 'string' ? evt.sessionId : sessionId,
          timestamp: typeof evt.timestamp === 'string' ? new Date(evt.timestamp).getTime() : undefined,
        });
        continue;
      }

      // Tool result array → extract results, don't emit as 'in'
      if (Array.isArray(content)) {
        for (const block of content) {
          if (typeof block === 'object' && block) {
            const b = block as Record<string, unknown>;
            if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
              toolResults.set(b.tool_use_id, {
                result: extractToolResultText(b.content) ?? '',
                isError: !!b.is_error,
              });
            }
          }
        }
      }
      continue;
    }

    // --- Assistant messages ---
    if (evt.type === 'assistant') {
      const msg = evt.message as Record<string, unknown> | undefined;
      if (msg?.role !== 'assistant') continue;
      const msgId = msg.id as string | undefined;
      if (!msgId) continue;

      let accum = assistantTurns.get(msgId);
      if (!accum) {
        accum = { texts: [], tools: [] };
        assistantTurns.set(msgId, accum);
      }

      // Capture model/usage from first occurrence
      if (!accum.model && typeof msg.model === 'string') accum.model = msg.model;
      if (!accum.timestamp && typeof evt.timestamp === 'string') accum.timestamp = evt.timestamp;
      if (accum.inputTokens == null && typeof msg.usage === 'object' && msg.usage) {
        const u = msg.usage as Record<string, number>;
        accum.inputTokens = (u.input_tokens ?? 0)
          + (u.cache_creation_input_tokens ?? 0)
          + (u.cache_read_input_tokens ?? 0);
        accum.outputTokens = u.output_tokens ?? 0;
      }

      const content = msg.content;
      if (!Array.isArray(content)) continue;

      for (const block of content as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const trimmed = (block.text as string).trim();
          if (trimmed) accum.texts.push(trimmed);
        } else if (block.type === 'tool_use') {
          accum.tools.push({
            id: typeof block.id === 'string' ? block.id : undefined,
            name: typeof block.name === 'string' ? block.name : 'tool',
            input: stringifyPreview(block.input),
            timestamp: typeof evt.timestamp === 'string' ? new Date(evt.timestamp).getTime() : undefined,
          });
        }
        // Skip 'thinking' blocks
      }
    }
  }

  // Phase 2: Attach tool results and build assistant messages
  for (const accum of assistantTurns.values()) {
    for (const tool of accum.tools) {
      if (tool.id) {
        const result = toolResults.get(tool.id);
        if (result) {
          tool.result = result.result;
          tool.isError = result.isError;
        }
      }
    }
  }

  const assistantMessages: ConversationMessage[] = [];
  for (const accum of assistantTurns.values()) {
    const content = accum.texts.join('\n\n');
    if (!content && accum.tools.length === 0) continue;

    const inputTokens = accum.inputTokens;
    const outputTokens = accum.outputTokens;
    assistantMessages.push({
      direction: 'out',
      content: content || (accum.tools.length ? '' : '(empty)'),
      sessionId,
      timestamp: accum.timestamp ? new Date(accum.timestamp).getTime() : undefined,
      tools: accum.tools.length ? accum.tools : undefined,
      provider: 'claude',
      model: accum.model,
      inputTokens,
      outputTokens,
      tokens: inputTokens != null || outputTokens != null
        ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined,
    });
  }

  // Phase 3: Sort all messages chronologically.
  // Each assistant turn is already grouped by msg.id in Phase 1, so no
  // cross-turn merging is needed — separate API turns stay separate.
  const all = [...userMessages, ...assistantMessages];
  all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  transcriptParseCache.set(`${sessionId}:${cwd}:${filePath}`, {
    filePath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    messages: all,
  });
  return all.slice(-limit).reverse();
}

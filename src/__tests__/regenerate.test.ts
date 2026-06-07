/**
 * WP7: readLastUserMessageText 单测 —— 端点 POST /api/messages/regenerate 的核心
 * helper。它扫多个 input-YYYY-MM-DD.log 文件,找最后一条 user 消息文本。
 * 不测完整端点(端点依赖 sessionManager + bridge.send,代价大;这里单测
 * 80% 路径——剩下 20% 是 entry.bridge.send 调用,已被既有 e2e 测试覆盖)。
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { readLastUserMessageText } from '../console.js';

const TEST_DIR = '/tmp/persona-regenerate-test';

function writeJsonl(file: string, lines: Array<Record<string, unknown>>): void {
  const content = lines.map(o => JSON.stringify(o)).join('\n') + '\n';
  writeFileSync(file, content, 'utf-8');
}

describe('readLastUserMessageText', () => {
  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  test('returns null when no log files', () => {
    expect(readLastUserMessageText([])).toBeNull();
  });

  test('returns null when log file exists but no user messages', () => {
    const logFile = join(TEST_DIR, 'input-20260101.log');
    writeJsonl(logFile, [
      { direction: 'out', text: 'assistant hi' },
      { direction: 'out', text: 'assistant again' },
    ]);
    expect(readLastUserMessageText([logFile])).toBeNull();
  });

  test('returns the last user message when found in single file', () => {
    const logFile = join(TEST_DIR, 'input-20260101.log');
    writeJsonl(logFile, [
      { direction: 'in', text: 'first user' },
      { direction: 'out', text: 'first reply' },
      { direction: 'in', text: 'second user' },
      { direction: 'out', text: 'second reply' },
      { direction: 'in', text: 'THIRD_AND_LAST user' },
    ]);
    expect(readLastUserMessageText([logFile])).toBe('THIRD_AND_LAST user');
  });

  test('scans multiple files: caller passes newest-first; last user from newest takes precedence', () => {
    // 调用方约定(见 console.ts regenerate 路由):先按文件名 sort().reverse() 传过来。
    // 这模拟昨天 + 今天两个文件:今天的 last user 优先。
    const today = join(TEST_DIR, 'input-20260105.log');
    const yesterday = join(TEST_DIR, 'input-20260104.log');
    writeJsonl(yesterday, [
      { direction: 'in', text: 'yesterday-last-user' },
      { direction: 'out', text: 'yesterday-reply' },
    ]);
    writeJsonl(today, [
      { direction: 'in', text: 'today-first' },
      { direction: 'out', text: 'today-reply' },
      { direction: 'in', text: 'TODAY_LAST' },
    ]);
    expect(readLastUserMessageText([today, yesterday])).toBe('TODAY_LAST');
  });

  test('skips malformed JSON lines without crashing', () => {
    const logFile = join(TEST_DIR, 'input-20260101.log');
    // 混合有效/无效行;最后一行有效
    appendFileSync(logFile, JSON.stringify({ direction: 'in', text: 'good1' }) + '\n', 'utf-8');
    appendFileSync(logFile, 'this is not json\n', 'utf-8');
    appendFileSync(logFile, '{broken json\n', 'utf-8');
    appendFileSync(logFile, JSON.stringify({ direction: 'out', text: 'out1' }) + '\n', 'utf-8');
    appendFileSync(logFile, JSON.stringify({ direction: 'in', text: 'good2_LAST' }) + '\n', 'utf-8');
    expect(readLastUserMessageText([logFile])).toBe('good2_LAST');
  });

  test('skips entries with empty text field', () => {
    const logFile = join(TEST_DIR, 'input-20260101.log');
    writeJsonl(logFile, [
      { direction: 'in', text: '' },
      { direction: 'in' }, // no text
      { direction: 'in', text: 'real-text' },
    ]);
    expect(readLastUserMessageText([logFile])).toBe('real-text');
  });

  test('handles file that does not exist (readdirSync may have stale list)', () => {
    const ghost = join(TEST_DIR, 'does-not-exist.log');
    const real = join(TEST_DIR, 'input-20260101.log');
    writeJsonl(real, [{ direction: 'in', text: 'found-it' }]);
    // ghost 在数组里,read 应该 try-catch 跳过
    expect(readLastUserMessageText([ghost, real])).toBe('found-it');
  });
});

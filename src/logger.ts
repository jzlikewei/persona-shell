/**
 * logger.ts — 日志分级 + 统一日志目录管理
 *
 * debug: 详细调试信息（raw content、mentions、session events、meta）
 * info:  重要生命周期事件（启动、flush、消息收发）
 * warn:  可恢复的异常
 * error: 需要关注的错误
 */

import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: string): void {
  if (level in LEVEL_ORDER) {
    currentLevel = level as LogLevel;
    console.log(`[logger] Log level set to: ${level}`);
  }
}

export function getLogLevel(): string {
  return currentLevel;
}

export const log = {
  debug: (...args: unknown[]) => {
    if (LEVEL_ORDER[currentLevel] <= LEVEL_ORDER.debug) console.log(...args);
  },
  info: (...args: unknown[]) => {
    if (LEVEL_ORDER[currentLevel] <= LEVEL_ORDER.info) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (LEVEL_ORDER[currentLevel] <= LEVEL_ORDER.warn) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    console.error(...args); // errors always print
  },
};

// ── 统一日志目录管理 ──

let logDir: string | null = null;

/** 初始化日志根目录（启动时调用一次，早于其他模块使用日志路径） */
export function initLogDir(personaDir: string): void {
  logDir = join(personaDir, 'logs');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
}

/** 获取日志根目录。未初始化时抛错。 */
export function getLogDir(): string {
  if (!logDir) throw new Error('log dir not initialized — call initLogDir(personaDir) first');
  return logDir;
}

/** 清理过期日志文件和空子目录。
 *  扫描 logDir 下所有文件（含子目录），删除 mtime 超过 retentionDays 的 .log 文件。 */
export function cleanupOldLogs(retentionDays: number = 7): number {
  if (!logDir || !existsSync(logDir)) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  let cleaned = 0;

  function walk(dir: string): void {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const fullPath = join(dir, name);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
          // 清理空子目录
          try {
            const remaining = readdirSync(fullPath);
            if (remaining.length === 0) rmSync(fullPath);
          } catch { /* ok */ }
        } else if (name.endsWith('.log') && stat.mtimeMs < cutoff) {
          rmSync(fullPath);
          cleaned++;
        }
      } catch { /* skip inaccessible */ }
    }
  }

  walk(logDir);
  return cleaned;
}

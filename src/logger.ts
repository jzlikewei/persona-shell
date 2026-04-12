/**
 * logger.ts — 简单日志分级
 *
 * debug: 详细调试信息（raw content、mentions、session events、meta）
 * info:  重要生命周期事件（启动、flush、消息收发）
 * warn:  可恢复的异常
 * error: 需要关注的错误
 */

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

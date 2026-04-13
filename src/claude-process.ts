/**
 * claude-process.ts — Claude CLI 进程生命周期管理
 *
 * 封装子进程 spawn、PID 追踪、FIFO pipe 创建/清理、进程信号发送。
 * SessionBridge 使用此模块管理底层进程，自身专注于会话协议层。
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { open } from 'fs/promises';
import { join } from 'path';
import type { FileHandle } from 'fs/promises';
import { spawnPersona } from './persona-process.js';

export interface ClaudeProcessPaths {
  /** FIFO pipe 存放目录 */
  pipeDir: string;
  /** PID 文件路径 */
  pidFile: string;
  /** 日志标签（用于 console 输出前缀） */
  label: string;
}

export interface ClaudeSpawnOptions {
  role: string;
  personaDir: string;
  claudePath: string;
  mcpConfigPath?: string;
  sessionId?: string;
  sessionName?: string;
  stderrPath?: string;
  env?: Record<string, string>;
}

export class ClaudeProcess {
  readonly pipeDir: string;
  readonly pipeIn: string;
  readonly pipeOut: string;
  private readonly pidFile: string;
  private readonly label: string;

  constructor(paths: ClaudeProcessPaths) {
    this.pipeDir = paths.pipeDir;
    this.pipeIn = join(paths.pipeDir, 'director-in');
    this.pipeOut = join(paths.pipeDir, 'director-out');
    this.pidFile = paths.pidFile;
    this.label = paths.label;
  }

  /** Ensure pipe directory exists */
  ensurePipeDir(): void {
    if (!existsSync(this.pipeDir)) {
      mkdirSync(this.pipeDir, { recursive: true });
    }
  }

  /** Create FIFO pipes if they don't exist */
  ensurePipes(): void {
    for (const pipe of [this.pipeIn, this.pipeOut]) {
      if (!existsSync(pipe)) {
        execSync(`mkfifo "${pipe}"`);
        console.log(`[director:${this.label}] Created FIFO: ${pipe}`);
      }
    }
  }

  /** Delete FIFO pipes */
  cleanPipes(): void {
    for (const pipe of [this.pipeIn, this.pipeOut]) {
      try { unlinkSync(pipe); } catch { /* ok */ }
    }
  }

  /** Spawn a Claude CLI foreground process with FIFO pipe redirection.
   *  Returns the PID, or null if spawn failed. */
  spawn(opts: ClaudeSpawnOptions): number | null {
    const { child } = spawnPersona({
      role: opts.role,
      personaDir: opts.personaDir,
      claudePath: opts.claudePath,
      mode: 'foreground',
      mcpConfigPath: opts.mcpConfigPath,
      sessionId: opts.sessionId,
      sessionName: opts.sessionName,
      pipeIn: this.pipeIn,
      pipeOut: this.pipeOut,
      stderrPath: opts.stderrPath ?? join(this.pipeDir, 'director-stderr.log'),
      env: opts.env,
    });

    const pid = child.pid ?? null;
    if (pid) {
      writeFileSync(this.pidFile, String(pid));
    }
    return pid;
  }

  /** Check if the managed process is still alive */
  isAlive(): boolean {
    const pid = this.getPid();
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Read PID from the PID file. Returns null if file doesn't exist or is invalid. */
  getPid(): number | null {
    try {
      const raw = readFileSync(this.pidFile, 'utf-8').trim();
      return parseInt(raw, 10) || null;
    } catch {
      return null;
    }
  }

  /** Send a signal to the process group. Returns true if signal was sent successfully. */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const pid = this.getPid();
    if (!pid) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false; // already dead
    }
  }

  /** Open FIFO pipes with timeout.
   *  Both ends are opened concurrently to unblock the FIFO handshake.
   *  Returns read/write FileHandles, or null on timeout. */
  async openPipes(timeoutMs: number): Promise<{ writeHandle: FileHandle; readHandle: FileHandle } | null> {
    const result = await Promise.race([
      Promise.all([
        open(this.pipeIn, 'w'),
        open(this.pipeOut, 'r'),
      ]),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);

    if (!result) return null;
    const [writeHandle, readHandle] = result;
    return { writeHandle, readHandle };
  }
}

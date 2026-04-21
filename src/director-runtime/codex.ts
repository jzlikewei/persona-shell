import type { ChildProcess } from 'child_process';
import { closeSync, existsSync, openSync, readSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';
import { spawnPersona } from '../persona-process.js';
import type { DirectorRuntimeOptions, DirectorRuntimeStatus, CodexTurnRuntimeHooks } from './index.js';

const MAX_RECENT_LINES = 8;
const MAX_STDERR_LINES = 12;
const MAX_STDERR_BYTES = 4096;

function getFileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function readLinesSince(path: string, startOffset: number): string[] {
  try {
    if (!existsSync(path)) return [];
    const size = statSync(path).size;
    if (size <= startOffset) return [];

    const readStart = Math.max(startOffset, size - MAX_STDERR_BYTES);
    const bytesToRead = size - readStart;
    if (bytesToRead <= 0) return [];

    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, readStart);
      const text = buffer.toString('utf-8', 0, bytesRead);
      return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-MAX_STDERR_LINES);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

export class CodexDirectorRuntime {
  readonly kind = 'codex-turn-based' as const;
  private activeChild: ChildProcess | null = null;
  private queue: string[] = [];
  private running = false;

  constructor(
    private readonly options: DirectorRuntimeOptions,
    private readonly hooks: CodexTurnRuntimeHooks,
  ) {}

  send(content: string): void {
    this.queue.push(content);
    this.processNextTurn();
  }

  hasActiveTurn(): boolean {
    return Boolean(this.activeChild?.pid);
  }

  kill(signal: NodeJS.Signals): void {
    const pid = this.activeChild?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // already exited
    }
  }

  getStatus(): DirectorRuntimeStatus {
    return {
      kind: this.kind,
      alive: true,
      pid: this.activeChild?.pid ?? null,
    };
  }

  private processNextTurn(): void {
    if (this.running) return;
    const content = this.queue.shift();
    if (!content) return;

    const startedAt = Date.now();
    this.running = true;
    const currentSessionName = this.hooks.getSessionName() ?? this.hooks.buildSessionName();
    if (!this.hooks.getSessionName()) this.hooks.setSessionName(currentSessionName);
    const stderrPath = join(this.options.logDir, 'director-stderr.log');
    const stderrStartOffset = getFileSize(stderrPath);

    const { child } = spawnPersona({
      role: 'director',
      personaDir: this.options.config.persona_dir,
      agent: this.options.agent,
      mode: 'background',
      prompt: content,
      resumeSessionId: this.hooks.getSessionId() ?? undefined,
      mcpConfigPath: join(this.options.config.persona_dir, ".mcp.json"),
      stderrPath,
      env: { DIRECTOR_LABEL: this.options.label },
    });

    this.activeChild = child;
    child.on('error', () => {});

    if (!child.stdout || !child.pid) {
      this.activeChild = null;
      this.running = false;
      this.hooks.onSpawnFailure('failed to spawn codex process');
      this.processNextTurn();
      return;
    }

    let currentResponse = '';
    let sawTurnCompleted = false;
    let lastErrorMessage: string | undefined;
    const recentLines: string[] = [];
    const rl = createInterface({ input: child.stdout });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      recentLines.push(line);
      if (recentLines.length > MAX_RECENT_LINES) recentLines.shift();
      this.hooks.onLine(line, currentSessionName);
      try {
        const event = JSON.parse(line);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          if (currentResponse && !currentResponse.endsWith('\n')) {
            currentResponse += '\n';
          }
          currentResponse += event.item.text;
        } else if (event.type === 'turn.completed') {
          sawTurnCompleted = true;
        } else if (event.type === 'error' && typeof event.message === 'string') {
          lastErrorMessage = event.message;
        } else if (event.type === 'turn.failed' && typeof event.error?.message === 'string') {
          lastErrorMessage = event.error.message;
        }
      } catch {
        // ignore malformed line
      }
    });

    child.on('close', (code) => {
      this.activeChild = null;
      this.running = false;
      const stderrTail = readLinesSince(stderrPath, stderrStartOffset);
      this.hooks.onClose({
        code,
        startedAt,
        currentResponse,
        sawTurnCompleted,
        lastErrorMessage,
        recentLines: [...recentLines],
        stderrTail,
      });
      this.processNextTurn();
    });
  }
}

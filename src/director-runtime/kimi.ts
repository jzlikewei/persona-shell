import type { ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { spawnPersona } from '../persona-process.js';
import type { SpawnResult } from '../persona-process.js';
import type { DirectorRuntimeStatus } from './index.js';

export interface KimiSpawnOptions {
  role: string;
  personaDir: string;
  agent: import('../persona-process.js').AgentRuntimeConfig;
  mcpConfigPath?: string;
  sessionId?: string;
  stderrPath?: string;
  env?: Record<string, string>;
}

export class KimiDirectorRuntime {
  readonly kind = 'kimi-daemon' as const;
  private child: ChildProcess | null = null;
  private writeStream: NodeJS.WritableStream | null = null;
  private readInterface: ReturnType<typeof createInterface> | null = null;

  spawn(options: KimiSpawnOptions): number | null {
    const { child } = spawnPersona({
      role: options.role,
      personaDir: options.personaDir,
      agent: options.agent,
      mode: 'foreground',
      mcpConfigPath: options.mcpConfigPath,
      sessionId: options.sessionId,
      stderrPath: options.stderrPath,
      env: options.env,
    });

    this.child = child;
    this.writeStream = child.stdin ?? null;

    child.on('exit', () => {
      this.writeStream = null;
    });

    return child.pid ?? null;
  }

  setupStdout(onLine: (line: string) => void, onClose: () => void): void {
    if (!this.child?.stdout) return;
    const rl = createInterface({ input: this.child.stdout });
    this.readInterface = rl;
    rl.on('line', (line) => {
      if (!line.trim()) return;
      onLine(line);
    });
    rl.on('close', () => {
      onClose();
    });
  }

  async write(payload: string): Promise<void> {
    if (!this.writeStream) throw new Error('stdin not open');
    this.writeStream.write(payload);
  }

  async closeStdin(): Promise<void> {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // already exited
    }
  }

  isAlive(): boolean {
    const pid = this.child?.pid;
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  getPid(): number | null {
    return this.child?.pid ?? null;
  }

  getStatus(): DirectorRuntimeStatus {
    return {
      kind: this.kind,
      alive: this.isAlive(),
      pid: this.getPid(),
    };
  }
}

import type { FileHandle } from 'fs/promises';
import { ClaudeProcess, type ClaudeSpawnOptions } from '../claude-process.js';
import type { DirectorRuntimeStatus } from './index.js';

export class ClaudeDirectorRuntime {
  readonly kind = 'claude-daemon' as const;
  readonly pipeDir: string;
  private process: ClaudeProcess;
  private writeHandle: FileHandle | null = null;

  constructor(options: { pipeDir: string; pidFile: string; label: string }) {
    this.pipeDir = options.pipeDir;
    this.process = new ClaudeProcess(options);
  }

  async start(spawnProcess: () => void, openTimeoutMs: number): Promise<{ freshStart: boolean; readHandle: FileHandle }> {
    this.process.ensurePipeDir();

    let freshStart = true;
    if (this.process.isAlive()) {
      freshStart = false;
    } else {
      this.process.ensurePipes();
      spawnProcess();
    }

    const handles = await this.process.openPipes(openTimeoutMs);
    if (!handles) {
      throw new Error(`Pipe open timeout after ${openTimeoutMs / 1000}s — process may have died`);
    }

    this.writeHandle = handles.writeHandle;
    return { freshStart, readHandle: handles.readHandle };
  }

  async write(pipePayload: string): Promise<void> {
    if (!this.writeHandle) throw new Error('pipe not open');
    await this.writeHandle.write(pipePayload);
  }

  async closeWriteHandle(): Promise<void> {
    await this.writeHandle?.close();
    this.writeHandle = null;
  }

  hasOpenWriteHandle(): boolean {
    return this.writeHandle !== null;
  }

  spawn(options: ClaudeSpawnOptions): number | null {
    return this.process.spawn(options);
  }

  kill(signal: NodeJS.Signals): void {
    this.process.kill(signal);
  }

  cleanPipes(): void {
    this.process.cleanPipes();
  }

  isAlive(): boolean {
    return this.process.isAlive();
  }

  getPid(): number | null {
    return this.process.getPid();
  }

  getStatus(): DirectorRuntimeStatus {
    return {
      kind: this.kind,
      alive: this.process.isAlive(),
      pid: this.process.getPid(),
    };
  }
}

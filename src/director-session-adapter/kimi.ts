import { join } from 'path';
import { KimiDirectorRuntime } from '../director-runtime/kimi.js';
import type { DirectorSessionAdapter, DirectorSessionAdapterHooks, DirectorSessionAdapterOptions } from './index.js';

export class KimiSessionAdapter implements DirectorSessionAdapter {
  private currentResponse = '';
  private collecting = false;

  constructor(
    private readonly runtime: KimiDirectorRuntime,
    private readonly options: DirectorSessionAdapterOptions,
    private readonly hooks: DirectorSessionAdapterHooks,
  ) {}

  async start(): Promise<boolean> {
    const restored = this.hooks.restorePersistedSession();
    const pid = this.runtime.spawn({
      role: this.options.personaRole ?? 'director',
      personaDir: this.options.config.persona_dir,
      agent: this.options.directorAgent,
      mcpConfigPath: join(this.options.config.persona_dir, '.mcp.json'),
      sessionId: restored.sessionId ?? undefined,
      stderrPath: join(this.options.logDir, `${this.options.label}-kimi-stderr.log`),
      env: { DIRECTOR_LABEL: this.options.label },
    });

    if (pid) {
      console.log(`[bridge:${this.options.label}] Spawned kimi process (pid: ${pid})`);
    }

    this.runtime.setupStdout(
      (line) => this.handleLine(line),
      () => this.hooks.onRuntimeClosed(),
    );

    return !restored.sessionId;
  }

  isReady(): boolean {
    return this.runtime.isAlive();
  }

  getStatus() {
    return this.runtime.getStatus();
  }

  hasActiveTurn(): boolean {
    return this.collecting;
  }

  async send(content: string): Promise<void> {
    const msg = JSON.stringify({ role: 'user', content }) + '\n';
    this.currentResponse = '';
    this.collecting = true;
    await this.runtime.write(msg);
  }

  async stop(): Promise<void> {
    await this.runtime.closeStdin();
  }

  terminate(signal: NodeJS.Signals): void {
    this.runtime.kill(signal);
  }

  interrupt(): void {
    this.runtime.kill('SIGINT');
  }

  async prepareShutdown(): Promise<boolean> {
    if (!this.runtime.isAlive()) {
      await this.runtime.closeStdin();
      return false;
    }
    return true;
  }

  async restartTransport(): Promise<void> {
    this.currentResponse = '';
    this.collecting = false;
    await this.runtime.closeStdin();

    if (this.runtime.isAlive()) {
      const maxWait = 5_000;
      const start = Date.now();
      while (this.runtime.isAlive() && Date.now() - start < maxWait) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (this.runtime.isAlive()) {
        console.warn(`[bridge:${this.options.label}] Process still alive after ${maxWait}ms, sending SIGKILL`);
        this.runtime.kill('SIGKILL');
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    await this.start();
  }

  describeSessionReady(label: string, _sessionId: string | null, _sessionName: string | null): string {
    return `[bridge:${label}] Kimi process connected`;
  }

  describeInterruptTarget(): string | null {
    const pid = this.runtime.getPid();
    return pid ? `(pid: ${pid})` : null;
  }

  shouldSkipInterruptWhileFlushing(): boolean {
    return true;
  }

  shouldTrackRestartBackoff(): boolean {
    return true;
  }

  private handleLine(line: string): void {
    this.hooks.logOutput(line);

    // Resume hint is printed as plain text when the process exits
    const resumeMatch = line.match(/To resume this session: kimi -r ([a-f0-9-]+)/);
    if (resumeMatch) {
      this.hooks.persistSession(resumeMatch[1], this.hooks.getSessionName());
      return;
    }

    try {
      const msg = JSON.parse(line);
      if (msg.role === 'assistant') {
        const text = this.extractText(msg);
        if (text) {
          this.currentResponse += text;
          this.hooks.onChunk(text);
        }
        if (!msg.tool_calls) {
          this.collecting = false;
          this.hooks.onTurnComplete({
            responseText: this.currentResponse.trim(),
            durationMs: null,
          });
          this.currentResponse = '';
        }
      }
    } catch {
      // ignore malformed or non-JSON lines
    }
  }

  private extractText(msg: unknown): string {
    if (!msg || typeof msg !== 'object') return '';
    const content = (msg as { content?: Array<{ type?: string; text?: string }> }).content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((c) => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text!)
      .join('');
  }
}

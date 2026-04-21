import { join } from 'path';
import { ClaudeDirectorRuntime } from '../director-runtime/claude.js';
import type { DirectorSessionAdapter, DirectorSessionAdapterHooks, DirectorSessionAdapterOptions } from './index.js';
import { attachReadHandle } from './index.js';

export class ClaudeSessionAdapter implements DirectorSessionAdapter {
  /** Collects text from assistant events across multi-turn responses */
  private assistantTexts: string[] = [];

  constructor(
    private readonly runtime: ClaudeDirectorRuntime,
    private readonly options: DirectorSessionAdapterOptions,
    private readonly hooks: DirectorSessionAdapterHooks,
  ) {}

  async start(): Promise<boolean> {
    const restored = this.hooks.restorePersistedSession();
    if (restored.sessionName) this.hooks.setSessionName(restored.sessionName);

    const { freshStart, readHandle } = await this.runtime.start(
      () => this.spawnProcess(restored.sessionId),
      30_000,
    );

    attachReadHandle(readHandle, {
      onLine: (line) => this.handleLine(line),
      onClose: () => this.hooks.onRuntimeClosed(),
    });

    return freshStart;
  }

  isReady(): boolean {
    return this.runtime.hasOpenWriteHandle();
  }

  getStatus() {
    return this.runtime.getStatus();
  }

  hasActiveTurn(): boolean {
    return this.runtime.isAlive();
  }

  async send(content: string): Promise<void> {
    const msg = { type: 'user', message: { role: 'user', content } };
    await this.runtime.write(JSON.stringify(msg) + '\n');
  }

  async stop(): Promise<void> {
    await this.runtime.closeWriteHandle();
  }

  terminate(signal: NodeJS.Signals): void {
    this.runtime.kill(signal);
  }

  interrupt(): void {
    this.runtime.kill('SIGINT');
  }

  async prepareShutdown(): Promise<boolean> {
    if (!this.runtime.isAlive()) {
      await this.runtime.closeWriteHandle();
      return false;
    }
    return true;
  }

  async restartTransport(): Promise<void> {
    this.assistantTexts = []; // clear stale assistant text from previous turn
    await this.runtime.closeWriteHandle();

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

    this.runtime.cleanPipes();
    await this.start();
  }

  describeSessionReady(label: string, _sessionId: string | null, _sessionName: string | null): string {
    return `[bridge:${label}] Pipes connected`;
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

  private spawnProcess(savedSession: string | null): void {
    const personaDir = this.options.config.persona_dir;
    if (savedSession) {
      console.log(`[bridge:${this.options.label}] Resuming session: ${savedSession}`);
    } else {
      console.log(`[bridge:${this.options.label}] Starting new session`);
    }

    const sessionName = this.buildClaudeSessionName();
    this.hooks.setSessionName(sessionName);

    const pid = this.runtime.spawn({
      role: this.options.personaRole ?? 'director',
      personaDir,
      agents: this.options.agents,
      mcpConfigPath: join(personaDir, '.mcp.json'),
      sessionId: savedSession ?? undefined,
      sessionName,
      stderrPath: join(this.runtime.pipeDir, 'director-stderr.log'),
      env: { DIRECTOR_LABEL: this.options.label },
    });

    if (pid) {
      console.log(`[bridge:${this.options.label}] Spawned claude process (pid: ${pid})`);
    }

    if (savedSession) {
      this.hooks.persistSession(savedSession, sessionName);
    }
  }

  private buildClaudeSessionName(): string {
    const now = new Date();
    const dateStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/-/g, '');
    const timeStr = now.toLocaleTimeString('sv-SE', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).replace(':', '');
    const nameParts = ['director', this.options.label, `${dateStr}T${timeStr}`];
    if (this.options.groupName) nameParts.push(this.options.groupName);
    return nameParts.join('-');
  }

  private handleLine(line: string): void {
    this.hooks.logOutput(line);

    try {
      const event = JSON.parse(line);

      switch (event.type) {
        case 'system':
          if (event.subtype === 'init' && typeof event.session_id === 'string') {
            this.hooks.persistSession(event.session_id, this.hooks.getSessionName());
          }
          break;

        case 'assistant': {
          // Each assistant event contains the complete text for one turn.
          // Collect these to build the full response across multi-turn (tool-use) interactions.
          const content = event.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                this.assistantTexts.push(block.text.trim());
              }
            }
          }
          break;
        }

        case 'stream_event': {
          const streamEvt = event.event;
          if (streamEvt?.type === 'content_block_delta' && streamEvt.delta?.type === 'text_delta') {
            const text = streamEvt.delta.text;
            if (text) this.hooks.onChunk(text);
          }
          break;
        }

        case 'result': {
          if (event.is_error && event.errors?.some((e: string) => e.includes('No conversation found'))) {
            console.warn(`[bridge:${this.options.label}] Session expired, clearing session for fresh start`);
            this.hooks.clearSession();
            break;
          }

          const metrics: Parameters<DirectorSessionAdapterHooks['onMetrics']>[0] = {};
          if (event.usage) {
            const totalInput = (event.usage.input_tokens ?? 0)
              + (event.usage.cache_creation_input_tokens ?? 0)
              + (event.usage.cache_read_input_tokens ?? 0);
            const numTurns = event.num_turns ?? 1;
            if (totalInput > 0 && numTurns > 0) {
              metrics.lastInputTokens = Math.round(totalInput / numTurns);
            }
          }

          if (event.modelUsage && typeof event.modelUsage === 'object') {
            for (const model of Object.values(event.modelUsage) as Array<Record<string, unknown>>) {
              if (typeof model?.contextWindow === 'number' && model.contextWindow > 0) {
                metrics.contextWindow = model.contextWindow as number;
                break;
              }
            }
          }

          if (typeof event.cost_usd === 'number') {
            metrics.costUsd = event.cost_usd;
          }
          this.hooks.onMetrics(metrics);

          // Use collected assistant texts (full multi-turn response) over result.result (last turn only)
          const fullResponseText = this.assistantTexts.length > 0
            ? this.assistantTexts.join('\n\n')
            : this.extractResponseText(event);
          this.assistantTexts = [];

          this.hooks.onTurnComplete({
            responseText: fullResponseText,
            durationMs: typeof event.duration_ms === 'number' ? event.duration_ms : null,
          });
          break;
        }
      }
    } catch {
      // ignore malformed line
    }
  }

  private extractResponseText(event: unknown): string {
    if (!event || typeof event !== 'object') return '';
    const evt = event as {
      result?: string;
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    };

    // Claude CLI result events carry the final text in `event.result` (string).
    // Fall back to `event.message.content` for forward-compatibility.
    if (typeof evt.result === 'string') return evt.result.trim();

    const content = evt.message?.content;
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';
    return content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim();
  }
}

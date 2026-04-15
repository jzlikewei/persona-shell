import type { ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { join } from 'path';
import { spawnPersona } from '../persona-process.js';
import type { DirectorRuntimeOptions, DirectorRuntimeStatus, CodexTurnRuntimeHooks } from './index.js';

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

    const { child } = spawnPersona({
      role: 'director',
      personaDir: this.options.config.persona_dir,
      agent: this.options.agent,
      mode: 'background',
      prompt: content,
      resumeSessionId: this.hooks.getSessionId() ?? undefined,
      stderrPath: join(this.options.logDir, 'director-stderr.log'),
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
    const rl = createInterface({ input: child.stdout });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      this.hooks.onLine(line, currentSessionName);
      try {
        const event = JSON.parse(line);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          currentResponse += event.item.text;
        } else if (event.type === 'turn.completed') {
          sawTurnCompleted = true;
        }
      } catch {
        // ignore malformed line
      }
    });

    child.on('close', (code) => {
      this.activeChild = null;
      this.running = false;
      this.hooks.onClose({
        code,
        startedAt,
        currentResponse,
        sawTurnCompleted,
      });
      this.processNextTurn();
    });
  }
}

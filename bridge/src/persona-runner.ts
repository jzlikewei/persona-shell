import { spawn } from 'child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { resolve, join, basename } from 'path';
import { readFile } from 'fs/promises';
import { load } from 'js-yaml';
import type { Config } from './config.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');
const PERSONAS_DIR = join(PROJECT_ROOT, 'personas');
const OUTBOX_DIR = join(PROJECT_ROOT, 'outbox');

interface PersonaFrontmatter {
  name: string;
  description: string;
  tools: string[];
}

interface PersonaDefinition {
  type: string;
  frontmatter: PersonaFrontmatter;
  content: string;       // full markdown (frontmatter + body)
  bodyMarkdown: string;  // body only (without frontmatter)
}

export interface TaskResult {
  taskId: string;
  personaType: string;
  result: unknown;
  raw: string;
}

let taskCounter = 0;

function parseFrontmatter(raw: string): { frontmatter: PersonaFrontmatter; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error('Invalid persona file: missing YAML frontmatter');
  }
  const frontmatter = load(match[1]) as PersonaFrontmatter;
  return { frontmatter, body: match[2] };
}

function loadPersona(type: string): PersonaDefinition {
  const filePath = join(PERSONAS_DIR, `${type}.md`);
  if (!existsSync(filePath)) {
    throw new Error(`Persona definition not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return { type, frontmatter, content: raw, bodyMarkdown: body };
}

/**
 * List available persona types by scanning the personas/ directory.
 */
export function listPersonaTypes(): string[] {
  if (!existsSync(PERSONAS_DIR)) return [];
  return readdirSync(PERSONAS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => basename(f, '.md'));
}

/**
 * Spawn a detached persona process. Returns a task ID immediately.
 *
 * The persona runs `claude -p` with the persona definition prepended to the
 * briefing as the prompt. Output is written to `outbox/task-{id}.json`.
 */
export function spawnPersona(
  type: string,
  briefing: string,
  config: Config['director'],
): string {
  const persona = loadPersona(type);
  const taskId = `${type}-${Date.now()}-${++taskCounter}`;
  const outFile = join(OUTBOX_DIR, `task-${taskId}.json`);

  if (!existsSync(OUTBOX_DIR)) {
    mkdirSync(OUTBOX_DIR, { recursive: true });
  }

  // Build the prompt: persona definition first, then briefing
  const prompt = `${persona.bodyMarkdown.trim()}\n\n---\n\n# Briefing\n\n${briefing}`;

  const claudePath = config.claude_path;
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
  ];

  // Use shell to redirect stdout to the output file
  const shellCmd = `${claudePath} ${args.map(shellEscape).join(' ')} > ${shellEscape(outFile)} 2>/dev/null`;

  const child = spawn('sh', ['-c', shellCmd], {
    detached: true,
    stdio: 'ignore',
    cwd: PROJECT_ROOT,
  });

  child.unref();
  console.log(`[persona-runner] Spawned ${type} persona (task: ${taskId}, pid: ${child.pid})`);

  return taskId;
}

/**
 * Poll the outbox directory until the task result file appears.
 * Returns the parsed result.
 */
export async function waitForResult(
  taskId: string,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<TaskResult> {
  const { timeoutMs = 300_000, intervalMs = 2_000 } = options ?? {};
  const outFile = join(OUTBOX_DIR, `task-${taskId}.json`);
  const personaType = taskId.split('-')[0];

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (existsSync(outFile)) {
      // File exists — but it might still be written to.
      // Wait a beat then read.
      await sleep(500);
      const raw = await readFile(outFile, 'utf-8');
      if (!raw.trim()) {
        // File created but empty, process still running
        await sleep(intervalMs);
        continue;
      }

      let result: unknown;
      try {
        result = JSON.parse(raw);
      } catch {
        result = raw;
      }

      return { taskId, personaType, result, raw };
    }
    await sleep(intervalMs);
  }

  throw new Error(`[persona-runner] Timeout waiting for task ${taskId} (${timeoutMs}ms)`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

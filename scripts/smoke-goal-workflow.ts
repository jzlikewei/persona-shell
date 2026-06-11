/**
 * Smoke test for Web UI + pShell Codex app-server goal workflow.
 *
 * This is intended to run after restarting the production/test Shell so the
 * backend code that forwards goal/plan/tool events is actually loaded.
 *
 * Usage:
 *   PERSONA_CONSOLE_URL=http://127.0.0.1:3000 \
 *   PERSONA_CONSOLE_TOKEN=... \
 *   PERSONA_GOAL_SMOKE_SESSION_ID=019... \
 *   bun scripts/smoke-goal-workflow.ts
 *
 * If PERSONA_GOAL_SMOKE_SESSION_ID is omitted, the script creates a fresh
 * codex session in PERSONA_GOAL_SMOKE_WORKSPACE (default: pshell-goal-smoke).
 * Fresh sessions may not emit thread/goal/updated unless the app-server has an
 * active goal context, so the strongest verification is against an existing
 * goal session.
 */

import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface ApiSessionWorkflow {
  workflow?: {
    turnId: string;
    goal?: { objective?: string; status?: string; tokensUsed?: number; timeUsedSeconds?: number };
    plan?: Array<{ step?: string; status?: string }>;
    explanation?: string | null;
    turnStatus?: string;
  } | null;
  tools?: Array<{ id?: string; name: string; status?: string; result?: string; input?: string }>;
  phase?: string | null;
}

interface TurnEvent {
  type: string;
  sessionId?: string | null;
  turnId?: string;
  goal?: { objective?: string; status?: string; tokensUsed?: number; timeUsedSeconds?: number };
  plan?: Array<{ step?: string; status?: string }>;
  tool?: { id?: string; name: string; status?: string; result?: string; input?: string };
  content?: string;
  error?: string;
}

interface WsEnvelope {
  type?: string;
  data?: unknown;
  event?: unknown;
}

interface CreateSessionResponse {
  ok?: boolean;
  sessionId?: string;
  error?: string;
}

const baseUrl = (process.env.PERSONA_CONSOLE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = process.env.PERSONA_CONSOLE_TOKEN || readConfigToken();
const workspace = process.env.PERSONA_GOAL_SMOKE_WORKSPACE || 'pshell-goal-smoke';
const agent = process.env.PERSONA_GOAL_SMOKE_AGENT || 'codex';
const smokeText = process.env.PERSONA_GOAL_SMOKE_TEXT || [
  '这是 pShell Web UI goal workflow smoke test。',
  '请先把以下内容设置成当前目标：验证 pShell Web UI 能展示 Codex app-server goal workflow。',
  '然后更新 plan，包含「运行 smoke 命令」和「汇报结果」两步。',
  '然后用 Bash 执行：for i in 1 2 3; do echo pshell-goal-workflow-smoke-$i; sleep 1; done',
  '命令完成并汇报前，请把当前 goal 标记为 complete。',
  '最后用一句话回复 smoke 完成。',
].join('\n');

function readConfigToken(): string {
  try {
    const path = join(homedir(), '.persona/config.yaml');
    const text = readFileSync(path, 'utf-8');
    let inConsole = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\S/.test(line)) inConsole = line.trim() === 'console:';
      if (!inConsole) continue;
      const match = line.match(/^\s+token:\s*["']?([^"'\s#]+)/);
      if (match?.[1]) return match[1];
    }
  } catch {
    // token is optional when console auth is disabled
  }
  return '';
}

function headers(): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) result.Authorization = `Bearer ${token}`;
  return result;
}

function wsUrl(): string {
  const url = new URL(baseUrl.replace(/^http/, 'ws'));
  url.pathname = '/ws';
  if (token) url.searchParams.set('token', token);
  return url.toString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function parseEnvelope(data: unknown): WsEnvelope | null {
  const text = typeof data === 'string'
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString('utf-8')
      : ArrayBuffer.isView(data)
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8')
        : '';
  if (!text) return null;
  const parsed = JSON.parse(text) as unknown;
  const record = asRecord(parsed);
  return { type: typeof record.type === 'string' ? record.type : undefined, data: record.data, event: record.event };
}

function parseTurnEvent(value: unknown): TurnEvent | null {
  const outer = asRecord(value);
  const source = outer.event && typeof outer.event === 'object' ? asRecord(outer.event) : outer;
  if (typeof source.type !== 'string') return null;
  const sessionId = typeof source.sessionId === 'string' || source.sessionId === null ? source.sessionId : undefined;
  const turnId = typeof source.turnId === 'string' ? source.turnId : undefined;
  const goalRecord = asRecord(source.goal);
  const goal = source.goal && typeof source.goal === 'object'
    ? {
        objective: typeof goalRecord.objective === 'string' ? goalRecord.objective : undefined,
        status: typeof goalRecord.status === 'string' ? goalRecord.status : undefined,
        tokensUsed: typeof goalRecord.tokensUsed === 'number' ? goalRecord.tokensUsed : undefined,
        timeUsedSeconds: typeof goalRecord.timeUsedSeconds === 'number' ? goalRecord.timeUsedSeconds : undefined,
      }
    : undefined;
  const plan = Array.isArray(source.plan)
    ? source.plan.map((item) => {
        const record = asRecord(item);
        return {
          step: typeof record.step === 'string' ? record.step : undefined,
          status: typeof record.status === 'string' ? record.status : undefined,
        };
      })
    : undefined;
  const toolRecord = asRecord(source.tool);
  const tool = source.tool && typeof source.tool === 'object' && typeof toolRecord.name === 'string'
    ? {
        id: typeof toolRecord.id === 'string' ? toolRecord.id : undefined,
        name: toolRecord.name,
        status: typeof toolRecord.status === 'string' ? toolRecord.status : undefined,
        result: typeof toolRecord.result === 'string' ? toolRecord.result : undefined,
        input: typeof toolRecord.input === 'string' ? toolRecord.input : undefined,
      }
    : undefined;
  return {
    type: source.type,
    sessionId,
    turnId,
    goal,
    plan,
    tool,
    content: typeof source.content === 'string' ? source.content : undefined,
    error: typeof source.error === 'string' ? source.error : undefined,
  };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}: ${await res.text()}`);
  return await res.json() as T;
}

async function ensureSession(): Promise<string> {
  const existing = process.env.PERSONA_GOAL_SMOKE_SESSION_ID;
  if (existing) return existing;
  const created = await postJson<CreateSessionResponse>('/api/sessions', { workspace, agent });
  if (!created.ok || !created.sessionId) throw new Error(`failed to create session: ${created.error ?? JSON.stringify(created)}`);
  return created.sessionId;
}

async function main(): Promise<void> {
  const sessionId = await ensureSession();
  console.log(`[smoke] base=${baseUrl} session=${sessionId}`);

  // Endpoint existence check: catches old production Shell before we spend time waiting for events.
  await getJson<ApiSessionWorkflow>(`/api/session-workflow?sessionId=${encodeURIComponent(sessionId)}`);

  const observed: TurnEvent[] = [];
  let snapshotDuringRun: ApiSessionWorkflow | null = null;

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`timeout waiting for goal workflow events; observed=${JSON.stringify(observed, null, 2)}`));
    }, Number(process.env.PERSONA_GOAL_SMOKE_TIMEOUT_MS || 120_000));

    function finish(): void {
      clearTimeout(timeout);
      ws.close();
      resolve();
    }

    function fail(error: unknown): void {
      clearTimeout(timeout);
      ws.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    ws.onopen = () => {
      setTimeout(() => {
        postJson<{ ok?: boolean; error?: string }>('/api/send', { sessionId, text: smokeText })
          .then((body) => {
            if (body.ok === false) fail(new Error(`/api/send failed: ${body.error ?? JSON.stringify(body)}`));
          })
          .catch(fail);
      }, 250);
    };

    ws.onerror = () => fail(new Error('websocket error'));

    ws.onmessage = (event) => {
      try {
        const envelope = parseEnvelope(event.data);
        if (envelope?.type !== 'turn_event') return;
        const payload = envelope.data ?? asRecord(envelope).event;
        const turnEvent = parseTurnEvent(payload);
        if (!turnEvent) return;
        if (turnEvent.sessionId && turnEvent.sessionId !== sessionId) return;
        observed.push(turnEvent);

        if ((turnEvent.type === 'goal_updated' || turnEvent.type === 'plan_updated' || turnEvent.type === 'tool_started') && !snapshotDuringRun) {
          getJson<ApiSessionWorkflow>(`/api/session-workflow?sessionId=${encodeURIComponent(sessionId)}`)
            .then((snapshot) => { snapshotDuringRun = snapshot; })
            .catch(() => {});
        }

        if (turnEvent.type === 'turn_failed') {
          fail(new Error(`turn failed: ${turnEvent.error ?? 'unknown'}`));
          return;
        }

        if (turnEvent.type === 'turn_completed') {
          setTimeout(finish, 500);
        }
      } catch (err) {
        fail(err);
      }
    };
  });

  const types = observed.map((event) => event.type);
  const turnIds = new Set(observed.map((event) => event.turnId).filter((value): value is string => Boolean(value)));
  const hasGoal = observed.some((event) => event.type === 'goal_updated' && event.goal?.objective);
  const hasTerminalGoal = observed.some((event) => event.type === 'goal_updated' && ['complete', 'completed', 'done'].includes(event.goal?.status ?? ''));
  const hasPlan = observed.some((event) => event.type === 'plan_updated' && event.plan && event.plan.length > 0);
  const hasRunningCommandOutput = observed.some((event) => event.type === 'tool_started' && event.tool?.name === 'Bash' && event.tool.status === 'running' && typeof event.tool.result === 'string' && event.tool.result.length > 0);
  const hasToolCompleted = observed.some((event) => event.type === 'tool_completed' && event.tool?.name === 'Bash');
  const hasCompleted = observed.some((event) => event.type === 'turn_completed');

  if (turnIds.size !== 1) throw new Error(`workflow events split across turnIds: ${JSON.stringify([...turnIds])}`);
  if (!hasGoal) throw new Error(`missing goal_updated with objective; types=${types.join(',')}`);
  if (!hasTerminalGoal) throw new Error(`missing terminal goal status; events=${JSON.stringify(observed, null, 2)}`);
  if (!hasPlan) throw new Error(`missing plan_updated with plan; types=${types.join(',')}`);
  if (!hasRunningCommandOutput) throw new Error(`missing running Bash command output; events=${JSON.stringify(observed, null, 2)}`);
  if (!hasToolCompleted) throw new Error(`missing Bash tool_completed; types=${types.join(',')}`);
  if (!hasCompleted) throw new Error(`missing turn_completed; types=${types.join(',')}`);
  if (!snapshotDuringRun?.workflow && !snapshotDuringRun?.tools?.length) {
    throw new Error(`session-workflow snapshot did not expose live workflow/tool state: ${JSON.stringify(snapshotDuringRun)}`);
  }

  console.log('[smoke] OK goal workflow visible and semantically unified');
  console.log(JSON.stringify({ sessionId, turnId: [...turnIds][0], eventTypes: types, snapshotDuringRun }, null, 2));
}

main().catch((err: unknown) => {
  console.error(`[smoke] FAIL ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

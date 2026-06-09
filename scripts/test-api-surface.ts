/**
 * API surface contract test — 验证 API 响应字段结构。
 *
 * 用于重构前冻结当前 API 合同：字段名、路径、响应结构。
 * 重构改名后这些测试应该 fail，然后同步更新到新字段名。
 *
 * 前置条件：test:shell 实例已在 localhost:3099 运行
 *   PERSONA_TEST=1 PERSONA_CONSOLE_PORT=3099 bun src/index.ts
 *
 *   bun scripts/test-api-surface.ts
 */

const baseUrl = (process.env.PERSONA_CONSOLE_URL || 'http://127.0.0.1:3099').replace(/\/+$/, '');
const wsUrl = baseUrl.replace(/^http/, 'ws');
const token = process.env.PERSONA_CONSOLE_TOKEN || '';

// ── helpers ──────────────────────────────────────────────────────────

interface TestResult { name: string; ok: boolean; error?: string }
const results: TestResult[] = [];

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function jsonHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, error: message });
    console.log(`  ❌ ${name} — ${message}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertField(obj: Record<string, unknown>, field: string, context: string): void {
  assert(field in obj, `${context}: missing field "${field}"`);
}

function assertFieldType(obj: Record<string, unknown>, field: string, type: string, context: string): void {
  assertField(obj, field, context);
  const actual = typeof obj[field];
  // Allow null for nullable fields
  if (obj[field] === null) return;
  assert(actual === type, `${context}: field "${field}" expected ${type}, got ${actual}`);
}

// ── Status snapshot structure ────────────────────────────────────────

async function testStatusSnapshotStructure(): Promise<void> {
  // Get status via WebSocket
  const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5_000);
    const wsHeaders: Record<string, string> = {};
    if (token) wsHeaders['Authorization'] = `Bearer ${token}`;
    const ws = new WebSocket(wsUrl, { headers: wsHeaders } as object);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
        if (msg.type === 'status') {
          clearTimeout(timeout);
          ws.close();
          resolve(msg.data);
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { clearTimeout(timeout); reject(new Error('ws error')); };
  });

  // system fields
  const system = data.system as Record<string, unknown>;
  assert(!!system, 'missing data.system');
  assertField(system, 'status', 'system');
  assertField(system, 'directorAlive', 'system');
  assertField(system, 'directorAgentName', 'system');
  assertField(system, 'directorAgentType', 'system');
  assertField(system, 'directorAgentModel', 'system');
  assertField(system, 'sessionId', 'system');
  assertField(system, 'personaRole', 'system');

  // context
  const context = data.context as Record<string, unknown>;
  assert(!!context, 'missing data.context');
  assertField(context, 'tokens', 'context');
  assertField(context, 'limit', 'context');
  assertField(context, 'percent', 'context');

  // pool array
  const pool = data.pool as Array<Record<string, unknown>>;
  assert(Array.isArray(pool), 'data.pool is not an array');
  // pool may be empty in test mode, but if entries exist, check structure
  if (pool.length > 0) {
    const entry = pool[0];
    assertField(entry, 'routingKey', 'pool[0]');
    assertField(entry, 'groupName', 'pool[0]');
    assertField(entry, 'label', 'pool[0]');
    assertField(entry, 'alive', 'pool[0]');
    assertField(entry, 'directorAgentName', 'pool[0]');
  }

  // runtime.pool should mirror pool
  const runtime = data.runtime as Record<string, unknown>;
  assert(!!runtime, 'missing data.runtime');
  assert(Array.isArray((runtime as Record<string, unknown>).pool), 'runtime.pool is not an array');

  // tasks
  const tasks = data.tasks as Record<string, unknown>;
  assert(!!tasks, 'missing data.tasks');
  assertField(tasks, 'summary', 'tasks');
  assertField(tasks, 'recent', 'tasks');
}

// ── Work context structure ───────────────────────────────────────────

async function testWorkContextStructure(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/work-context`, { headers: authHeaders() });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  assert(Array.isArray(body.workspaces), 'workspaces is not an array');
  // Each workspace should have name
  const workspaces = body.workspaces as Array<Record<string, unknown>>;
  if (workspaces.length > 0) {
    assertField(workspaces[0], 'name', 'workspace[0]');
  }
}

// ── Sessions structure ───────────────────────────────────────────────

async function testSessionsStructure(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/sessions?workspace=main`, { headers: authHeaders() });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as Array<Record<string, unknown>>;
  assert(Array.isArray(body), 'response is not an array');
  if (body.length > 0) {
    assertField(body[0], 'sessionId', 'session[0]');
    assertField(body[0], 'workspace', 'session[0]');
  }
}

// ── Director runtime APIs (current paths, will move to /api/runtime/) ─

async function testDirectorsQueueCancel(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/directors/queue/cancel`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ director_label: 'main', correlation_id: 'nonexistent' }),
  });
  // May return 404 (no such item) or 200 — we just check it responds and has expected fields
  const body = await res.json() as Record<string, unknown>;
  assert(typeof body === 'object' && body !== null, 'response is not an object');
}

async function testDirectorsSwitchAgent(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/directors/switch-agent`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ director_label: 'main', agent: 'claude' }),
  });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  assertField(body, 'ok', 'switch-agent response');
  assertField(body, 'director_label', 'switch-agent response');
  assertField(body, 'agent', 'switch-agent response');
}

async function testDirectorsCommand(): Promise<void> {
  // Use 'esc' which is safe — just cancels current processing
  const res = await fetch(`${baseUrl}/api/directors/command`, {
    method: 'POST',
    headers: jsonHeaders(),
    body: JSON.stringify({ director_label: 'main', command: 'esc' }),
  });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  assertField(body, 'ok', 'command response');
  assertField(body, 'director_label', 'command response');
  assertField(body, 'command', 'command response');
}

// Note: /api/directors/shutdown requires a non-main label, skip in smoke test.
// Note: /api/directors/switch-persona requires valid persona, skip.

// ── Config summary ───────────────────────────────────────────────────

async function testConfigSummary(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/config-summary`, { headers: authHeaders() });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json() as Record<string, unknown>;
  assert(typeof body === 'object' && body !== null, 'response is not an object');
}

// ── main ─────────────────────────────────────────────────────────────

console.log(`\n[test-api-surface] target: ${baseUrl}\n`);
console.log('  Testing API field structures (pre-refactor freeze)...\n');

await runTest('Status snapshot: system fields (directorAlive, directorAgentName, etc.)', testStatusSnapshotStructure);
await runTest('Work context: workspace structure', testWorkContextStructure);
await runTest('Sessions: list structure', testSessionsStructure);
await runTest('Directors API: queue/cancel (current path /api/directors/)', testDirectorsQueueCancel);
await runTest('Directors API: switch-agent (current path, response has director_label)', testDirectorsSwitchAgent);
await runTest('Directors API: command (current path, response has director_label)', testDirectorsCommand);
await runTest('Config summary', testConfigSummary);

// ── summary ──────────────────────────────────────────────────────────

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[test-api-surface] ${passed} passed, ${failed} failed, ${results.length} total`);

if (failed > 0) {
  console.log('\nFailed tests:');
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  - ${r.name}: ${r.error}`);
  }
  process.exit(1);
}

console.log('\n  All API surface contracts verified. ✓\n');

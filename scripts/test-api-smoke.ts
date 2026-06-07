/**
 * Phase 3.3 — 后端 API 冒烟测试
 *
 * 假设 test:shell 实例已在 localhost:3099 运行。
 *   bun scripts/test-api-smoke.ts
 *
 * 环境变量：
 *   PERSONA_CONSOLE_URL   — 默认 http://127.0.0.1:3099
 *   PERSONA_CONSOLE_TOKEN — Bearer auth token（可选）
 */

const baseUrl = (process.env.PERSONA_CONSOLE_URL || 'http://127.0.0.1:3099').replace(/\/+$/, '');
const wsUrl = baseUrl.replace(/^http/, 'ws');
const token = process.env.PERSONA_CONSOLE_TOKEN || '';

// ── helpers ──────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  ok: boolean;
  error?: string;
}

const results: TestResult[] = [];

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
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

// ── test cases ───────────────────────────────────────────────────────

async function testGetMessages(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/messages?sessionId=smoke&limit=10`, { headers: authHeaders() });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body), 'response is not an array');
}

async function testGetTasks(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/tasks?limit=5`, { headers: authHeaders() });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body), 'response is not an array');
}

async function testGetTasksGroupFilter(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/tasks?group_name=main&limit=5`, { headers: authHeaders() });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body), 'response is not an array');
}

async function testPostSend(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/send`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ text: '!echo smoke-api-test' }),
  });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, `expected ok=true, got ${JSON.stringify(body)}`);
}

async function testPostEsc(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/esc`, {
    method: 'POST',
    headers: headers(),
  });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(typeof body.ok === 'boolean', `expected ok boolean, got ${JSON.stringify(body)}`);
}

async function testGetWorkContext(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/work-context`, { headers: authHeaders() });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(body && typeof body === 'object', 'response is not an object');
  assert(Array.isArray(body.workspaces), 'response.workspaces is not an array');
}

async function testGetCronJobs(): Promise<void> {
  const res = await fetch(`${baseUrl}/api/cron-jobs`, { headers: authHeaders() });
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body), 'response is not an array');
}

async function testWebSocketStatus(): Promise<void> {
  const wsHeaders: Record<string, string> = {};
  if (token) wsHeaders['Authorization'] = `Bearer ${token}`;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('timeout: no status event within 5s'));
    }, 5_000);

    const ws = new WebSocket(wsUrl, { headers: wsHeaders } as object);

    ws.onmessage = (event) => {
      try {
        const text = typeof event.data === 'string' ? event.data : String(event.data);
        const msg = JSON.parse(text);
        if (msg.type === 'status') {
          assert(msg.data && typeof msg.data === 'object', 'status event missing data');
          clearTimeout(timeout);
          ws.close();
          resolve();
        }
      } catch {
        // ignore non-JSON or other events
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('websocket connection error'));
    };
  });
}

// ── main ─────────────────────────────────────────────────────────────

console.log(`\n[test-api-smoke] target: ${baseUrl}\n`);

await runTest('GET /api/messages?sessionId=xxx&limit=10', testGetMessages);
await runTest('GET /api/tasks?limit=5', testGetTasks);
await runTest('GET /api/tasks?group_name=main&limit=5', testGetTasksGroupFilter);
await runTest('POST /api/send', testPostSend);
await runTest('POST /api/esc', testPostEsc);
await runTest('GET /api/work-context', testGetWorkContext);
await runTest('GET /api/cron-jobs', testGetCronJobs);
await runTest('WebSocket status event', testWebSocketStatus);

// ── summary ──────────────────────────────────────────────────────────

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n[test-api-smoke] ${passed} passed, ${failed} failed, ${results.length} total`);

if (failed > 0) {
  console.log('\nFailed tests:');
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  - ${r.name}: ${r.error}`);
  }
  process.exit(1);
}

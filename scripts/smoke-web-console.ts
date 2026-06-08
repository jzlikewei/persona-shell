const baseUrl = (process.env.PERSONA_CONSOLE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const wsUrl = baseUrl.replace(/^http/, 'ws');

function fail(message: string): never {
  console.error(`[smoke:web] ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`[smoke:web] ${message}`);
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${baseUrl}${path}`, init);
  } catch (err) {
    fail(`${path} request failed: ${String(err)}`);
  }
}

async function readText(path: string, expectedStatus = 200): Promise<string> {
  const res = await request(path);
  const text = await res.text();
  if (res.status !== expectedStatus) fail(`${path} returned ${res.status}, expected ${expectedStatus}: ${text}`);
  return text;
}

async function readJson(path: string, expectedStatus = 200): Promise<unknown> {
  const text = await readText(path, expectedStatus);
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${path} returned invalid JSON: ${String(err)}`);
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) fail(`${label} is not an array`);
  return value as Array<Record<string, unknown>>;
}

async function smokeFrontendEntry(): Promise<void> {
  const html = await readText('/');
  if (!html.includes('<div id="root"></div>')) fail('/ missing React root');
  if (!html.includes('/assets/')) fail('/ missing built web-v2 assets');
  const legacy = await readText('/v1', 410);
  if (!legacy.includes('Web v1 has been removed')) fail('/v1 did not return removal notice');
  pass('web-v2 entry ok');
}

async function smokeReadApis(): Promise<void> {
  const context = asObject(await readJson('/api/work-context'), '/api/work-context');
  asArray(context.projects, '/api/work-context.projects');
  const workspaces = asArray(context.workspaces, '/api/work-context.workspaces');
  if (!workspaces.some((workspace) => workspace.id === 'main' || workspace.source === 'main')) {
    fail('/api/work-context missing main workspace');
  }

  const sessions = asArray(await readJson('/api/sessions?workspace=main'), '/api/sessions');
  for (const session of sessions) {
    if (typeof session.sessionId !== 'string') fail('/api/sessions row missing sessionId');
    if (session.workspace !== 'main') fail('/api/sessions row has wrong workspace');
    if ('messageCount' in session) fail('/api/sessions still exposes messageCount');
  }

  asArray(await readJson('/api/tasks?limit=5'), '/api/tasks');
  asArray(await readJson('/api/cron-jobs'), '/api/cron-jobs');

  const files = asObject(await readJson('/api/files?scope=task-results'), '/api/files');
  asArray(files.files, '/api/files.files');
  pass('read APIs ok');
}

async function smokeMutationGuards(): Promise<void> {
  const send = await request('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'missing session' }),
  });
  if (send.status !== 400) fail(`/api/send without sessionId returned ${send.status}, expected 400`);
  const sendBody = asObject(await send.json(), '/api/send invalid');
  if (sendBody.ok !== false || typeof (sendBody.error ?? sendBody.message) !== 'string') {
    fail('/api/send invalid response shape changed');
  }

  const messages = await request('/api/messages?director=main');
  if (messages.status !== 400) fail(`/api/messages without sessionId returned ${messages.status}, expected 400`);
  pass('mutation guards ok');
}

async function smokeWebSocket(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket connect timeout')), 5_000);
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('websocket connection failed'));
    };
  }).catch((err) => fail(String(err)));
  pass('websocket ok');
}

async function main(): Promise<void> {
  await smokeFrontendEntry();
  await smokeReadApis();
  await smokeMutationGuards();
  await smokeWebSocket();
  pass('all checks passed');
}

main().catch((err) => fail(String(err)));

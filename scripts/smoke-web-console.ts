const baseUrl = (process.env.PERSONA_CONSOLE_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const wsUrl = baseUrl.replace(/^http/, 'ws');

function fail(message: string): never {
  console.error(`[smoke:web] ${message}`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`[smoke:web] ${message}`);
}

async function readJson(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`);
  const text = await res.text();
  if (!res.ok) fail(`${path} failed: ${res.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${path} returned invalid JSON: ${String(err)}`);
  }
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`${path} failed: ${res.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${path} returned invalid JSON: ${String(err)}`);
  }
}

async function requestJson(path: string, init: RequestInit, expectedStatus?: number): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  if (expectedStatus != null ? res.status !== expectedStatus : !res.ok) {
    fail(`${init.method || 'GET'} ${path} returned ${res.status}, expected ${expectedStatus ?? '2xx'}: ${text}`);
  }
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch (err) {
    fail(`${init.method || 'GET'} ${path} returned invalid JSON: ${String(err)}`);
  }
}

async function readOk(path: string): Promise<Response> {
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    fail(`${path} failed: ${res.status} ${text}`);
  }
  return res;
}

async function readText(path: string): Promise<string> {
  const res = await readOk(path);
  return res.text();
}

function assertIncludes(source: string, needle: string, label: string): void {
  if (!source.includes(needle)) fail(`${label} missing ${needle}`);
}

function asArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) fail(`${label} is not an array`);
  return value as Array<Record<string, unknown>>;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function expectArrayProperty(value: Record<string, unknown>, property: string, label: string): void {
  if (!Array.isArray(value[property])) fail(`${label}.${property} is not an array`);
}

async function smokeFrontendShell(): Promise<void> {
  const html = await readText('/');
  [
    '<title>Persona Console</title>',
    'id="primary-nav"',
    'id="chat-container"',
    'id="chat-input-bar"',
    'src="js/app.js"',
    'href="css/style.css"',
    '>Overview<',
    '>Console<',
    '>Runtime<',
    '>Tasks<',
    '>Auto<',
    '>Persona<',
    '>Files<',
    '>Logs<',
    '>Settings<',
  ].forEach((needle) => assertIncludes(html, needle, '/'));

  const appJs = await readText('/js/app.js');
  [
    'window.selectNav = function(section)',
    'function renderDashboard()',
    'Workbench Overview',
    'function renderRuntimeView()',
    'function renderTasksHome()',
    'function renderAutomationsView()',
    'function renderPersonaView()',
    'function renderFilesView()',
    'function renderObservabilityView()',
    'function renderSettingsView()',
    'API Explorer',
    'WebSocket Events',
    'Debug Bundle Evidence',
    'danger-approval-queue',
    'chat_attachment',
  ].forEach((needle) => assertIncludes(appJs, needle, '/js/app.js'));

  const css = await readText('/css/style.css');
  [
    '#primary-nav',
    '.workbench-panel',
    '#chat-container',
    '#chat-input-bar',
  ].forEach((needle) => assertIncludes(css, needle, '/css/style.css'));

  pass('frontend shell ok');
}

async function smokeTaskAndFileDetails(): Promise<void> {
  const tasks = asArray(await readJson('/api/tasks?limit=20'), '/api/tasks');
  const sampleTask = tasks.find((task) => typeof task.id === 'string');
  if (sampleTask && typeof sampleTask.id === 'string') {
    const task = asObject(
      await readJson(`/api/tasks/${encodeURIComponent(sampleTask.id)}`),
      '/api/tasks/{id}',
    );
    if (task.id !== sampleTask.id) fail('/api/tasks/{id} returned a different task id');

    const logs = asObject(
      await readJson(`/api/tasks/${encodeURIComponent(sampleTask.id)}/logs`),
      '/api/tasks/{id}/logs',
    );
    expectArrayProperty(logs, 'entries', '/api/tasks/{id}/logs');
    if (typeof logs.totalLines !== 'number') fail('/api/tasks/{id}/logs missing totalLines number');
  }

  const taskFiles = asObject(await readJson('/api/files?scope=task-results'), '/api/files?scope=task-results');
  expectArrayProperty(taskFiles, 'files', '/api/files?scope=task-results');
  const files = taskFiles.files as Array<Record<string, unknown>>;
  const sampleFile = files.find((file) => typeof file.path === 'string' && Number(file.size || 0) > 0);
  if (sampleFile && typeof sampleFile.path === 'string') {
    const content = asObject(
      await readJson(`/api/files/content?path=${encodeURIComponent(sampleFile.path)}`),
      '/api/files/content',
    );
    if (content.previewable !== true && content.previewable !== false) fail('/api/files/content missing previewable boolean');
    if (content.previewable === true && typeof content.content !== 'string' && typeof content.dataUrl !== 'string') {
      fail('/api/files/content preview has neither content nor dataUrl');
    }

    const download = await readOk(`/api/files/download?path=${encodeURIComponent(sampleFile.path)}`);
    const bytes = await download.arrayBuffer();
    if (bytes.byteLength === 0) fail('/api/files/download returned an empty body');
  }

  const outputTask = tasks.find((task) => typeof task.id === 'string' && typeof task.result_file === 'string');
  if (outputTask && typeof outputTask.id === 'string') {
    const output = asObject(
      await readJson(`/api/tasks/${encodeURIComponent(outputTask.id)}/output`),
      '/api/tasks/{id}/output',
    );
    if (typeof output.content !== 'string' || typeof output.path !== 'string') {
      fail('/api/tasks/{id}/output missing content/path strings');
    }
  }

  pass('task/file details ok');
}

async function smokeAutomationAndMaintenanceDetails(): Promise<void> {
  const cronJobs = asArray(await readJson('/api/cron-jobs'), '/api/cron-jobs');
  const sampleCron = cronJobs.find((job) => typeof job.id === 'string');
  if (sampleCron && typeof sampleCron.id === 'string') {
    const cron = asObject(
      await readJson(`/api/cron-jobs/${encodeURIComponent(sampleCron.id)}`),
      '/api/cron-jobs/{id}',
    );
    if (cron.id !== sampleCron.id) fail('/api/cron-jobs/{id} returned a different cron id');
  }

  const cleanup = asObject(
    await readJson('/api/tasks/cleanup?older_than_days=30&status=terminal'),
    '/api/tasks/cleanup',
  );
  if (typeof cleanup.eligibleCount !== 'number') fail('/api/tasks/cleanup missing eligibleCount number');
  if (typeof cleanup.cutoff !== 'string') fail('/api/tasks/cleanup missing cutoff string');
  expectArrayProperty(cleanup, 'samples', '/api/tasks/cleanup');

  pass('automation/maintenance details ok');
}

async function smokeMutationGuards(): Promise<void> {
  const invalidTaskCreate = await requestJson('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, 400);
  const invalidTaskCreateBody = asObject(invalidTaskCreate.body, 'POST /api/tasks invalid');
  if (invalidTaskCreateBody.ok !== false) fail('POST /api/tasks invalid did not return ok=false');
  if (typeof invalidTaskCreateBody.error !== 'string' || !invalidTaskCreateBody.error.includes('required')) {
    fail('POST /api/tasks invalid missing required-field error');
  }

  const missingTaskId = `T-smoke-missing-${Date.now().toString(36)}`;
  const cancel = await requestJson(`/api/tasks/${encodeURIComponent(missingTaskId)}/cancel`, {
    method: 'POST',
  }, 404);
  const cancelBody = asObject(cancel.body, 'POST /api/tasks/{missing}/cancel');
  if (cancelBody.ok !== false) fail('POST /api/tasks/{missing}/cancel did not return ok=false');
  if (typeof cancelBody.error !== 'string' || !cancelBody.error.includes('not found')) {
    fail('POST /api/tasks/{missing}/cancel missing not-found error');
  }

  const retry = await requestJson(`/api/tasks/${encodeURIComponent(missingTaskId)}/retry`, {
    method: 'POST',
  }, 404);
  const retryBody = asObject(retry.body, 'POST /api/tasks/{missing}/retry');
  if (retryBody.ok !== false) fail('POST /api/tasks/{missing}/retry did not return ok=false');
  if (typeof retryBody.error !== 'string' || !retryBody.error.includes('not found')) {
    fail('POST /api/tasks/{missing}/retry missing not-found error');
  }

  const invalidCronCreate = await requestJson('/api/cron-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, 400);
  const invalidCronCreateBody = asObject(invalidCronCreate.body, 'POST /api/cron-jobs invalid');
  if (invalidCronCreateBody.ok !== false) fail('POST /api/cron-jobs invalid did not return ok=false');
  if (typeof invalidCronCreateBody.error !== 'string' || !invalidCronCreateBody.error.includes('required')) {
    fail('POST /api/cron-jobs invalid missing required-field error');
  }

  const missingCronId = `C-smoke-missing-${Date.now().toString(36)}`;
  const cronDelete = await requestJson(`/api/cron-jobs/${encodeURIComponent(missingCronId)}`, {
    method: 'DELETE',
  }, 404);
  const cronDeleteBody = asObject(cronDelete.body, 'DELETE /api/cron-jobs/{missing}');
  if (cronDeleteBody.ok !== false) fail('DELETE /api/cron-jobs/{missing} did not return ok=false');
  if (typeof cronDeleteBody.error !== 'string' || !cronDeleteBody.error.includes('not found')) {
    fail('DELETE /api/cron-jobs/{missing} missing not-found error');
  }

  const cronToggle = await requestJson(`/api/cron-jobs/${encodeURIComponent(missingCronId)}/toggle`, {
    method: 'POST',
  }, 404);
  const cronToggleBody = asObject(cronToggle.body, 'POST /api/cron-jobs/{missing}/toggle');
  if (cronToggleBody.ok !== false) fail('POST /api/cron-jobs/{missing}/toggle did not return ok=false');

  const cronRun = await requestJson(`/api/cron-jobs/${encodeURIComponent(missingCronId)}/run`, {
    method: 'POST',
  }, 404);
  const cronRunBody = asObject(cronRun.body, 'POST /api/cron-jobs/{missing}/run');
  if (cronRunBody.ok !== false) fail('POST /api/cron-jobs/{missing}/run did not return ok=false');

  const cronUpdate = await requestJson(`/api/cron-jobs/${encodeURIComponent(missingCronId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  }, 404);
  const cronUpdateBody = asObject(cronUpdate.body, 'PUT /api/cron-jobs/{missing}');
  if (cronUpdateBody.ok !== false) fail('PUT /api/cron-jobs/{missing} did not return ok=false');

  const invalidSessionLink = await requestJson('/api/persona/session-links', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, 400);
  const invalidSessionLinkBody = asObject(invalidSessionLink.body, 'POST /api/persona/session-links invalid');
  if (invalidSessionLinkBody.ok !== false) fail('POST /api/persona/session-links invalid did not return ok=false');
  if (typeof invalidSessionLinkBody.error !== 'string' || !invalidSessionLinkBody.error.includes('required')) {
    fail('POST /api/persona/session-links invalid missing required-field error');
  }

  const missingSessionLinkChannel = 'smoke';
  const missingSessionLinkExternalId = `missing-${Date.now().toString(36)}`;
  const missingSessionLinkKey = `${missingSessionLinkChannel}:${missingSessionLinkExternalId}`;
  const deleteSessionLink = await requestJson(
    `/api/persona/session-links?channel=${encodeURIComponent(missingSessionLinkChannel)}&external_id=${encodeURIComponent(missingSessionLinkExternalId)}`,
    { method: 'DELETE' },
    404,
  );
  const deleteSessionLinkBody = asObject(deleteSessionLink.body, 'DELETE /api/persona/session-links missing');
  if (deleteSessionLinkBody.ok !== false) fail('DELETE /api/persona/session-links missing did not return ok=false');
  if (typeof deleteSessionLinkBody.error !== 'string' || !deleteSessionLinkBody.error.includes('not found')) {
    fail('DELETE /api/persona/session-links missing missing not-found error');
  }

  const invalidAttachmentSend = await requestJson('/api/send-attachment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_director: 'main', target_channel: 'web' }),
  }, 400);
  const invalidAttachmentSendBody = asObject(invalidAttachmentSend.body, 'POST /api/send-attachment invalid');
  if (invalidAttachmentSendBody.ok !== false) fail('POST /api/send-attachment invalid did not return ok=false');
  if (typeof invalidAttachmentSendBody.error !== 'string' || !invalidAttachmentSendBody.error.includes('path is required')) {
    fail('POST /api/send-attachment invalid missing path-required error');
  }

  const invalidOpenPath = await requestJson('/api/open-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, 400);
  const invalidOpenPathBody = asObject(invalidOpenPath.body, 'POST /api/open-path invalid');
  if (invalidOpenPathBody.ok !== false) fail('POST /api/open-path invalid did not return ok=false');
  if (typeof invalidOpenPathBody.error !== 'string' || !invalidOpenPathBody.error.includes('path or persona_doc is required')) {
    fail('POST /api/open-path invalid missing path-required error');
  }

  const missingRoutingKey = `web-smoke-missing-${Date.now().toString(36)}`;
  const close = await requestJson(`/api/web-sessions/${encodeURIComponent(missingRoutingKey)}`, {
    method: 'DELETE',
  }, 404);
  const closeBody = asObject(close.body, 'DELETE /api/web-sessions/{missing}');
  if (closeBody.ok !== false) fail('DELETE /api/web-sessions/{missing} did not return ok=false');
  if (typeof closeBody.error !== 'string' || !closeBody.error.includes('not found')) {
    fail('DELETE /api/web-sessions/{missing} missing not-found error');
  }

  const audit = asObject(await readJson('/api/audit-log?limit=20'), '/api/audit-log after missing web session close');
  const entries = asArray(audit.entries, '/api/audit-log.entries');
  const taskCreateAuditEntry = entries.find((entry) => entry.action === 'task.create' && entry.ok === false);
  if (!taskCreateAuditEntry) fail('invalid task create was not recorded as a failed audit entry');
  const taskCreateDetail = asObject(taskCreateAuditEntry.detail, 'task.create audit detail');
  if (typeof taskCreateDetail.error !== 'string' || !taskCreateDetail.error.includes('required')) {
    fail('invalid task create audit entry missing required-field error');
  }

  const taskAuditEntry = entries.find((entry) => (
    entry.action === 'task.cancel'
    && entry.ok === false
    && entry.target === missingTaskId
  ));
  if (!taskAuditEntry) fail('missing task cancel was not recorded as a failed audit entry');

  const taskRetryAuditEntry = entries.find((entry) => (
    entry.action === 'task.retry'
    && entry.ok === false
    && entry.target === missingTaskId
  ));
  if (!taskRetryAuditEntry) fail('missing task retry was not recorded as a failed audit entry');

  const cronCreateAuditEntry = entries.find((entry) => entry.action === 'cron.create' && entry.ok === false);
  if (!cronCreateAuditEntry) fail('invalid cron create was not recorded as a failed audit entry');
  const cronCreateDetail = asObject(cronCreateAuditEntry.detail, 'cron.create audit detail');
  if (typeof cronCreateDetail.error !== 'string' || !cronCreateDetail.error.includes('required')) {
    fail('invalid cron create audit entry missing required-field error');
  }

  const sessionLinkUpsertAuditEntry = entries.find((entry) => entry.action === 'persona.session_link.upsert' && entry.ok === false);
  if (!sessionLinkUpsertAuditEntry) fail('invalid session link upsert was not recorded as a failed audit entry');
  const sessionLinkUpsertDetail = asObject(sessionLinkUpsertAuditEntry.detail, 'persona.session_link.upsert audit detail');
  if (typeof sessionLinkUpsertDetail.error !== 'string' || !sessionLinkUpsertDetail.error.includes('required')) {
    fail('invalid session link upsert audit entry missing required-field error');
  }

  const sessionLinkDeleteAuditEntry = entries.find((entry) => (
    entry.action === 'persona.session_link.delete'
    && entry.ok === false
    && entry.target === missingSessionLinkKey
  ));
  if (!sessionLinkDeleteAuditEntry) fail('missing session link delete was not recorded as a failed audit entry');

  const attachmentAuditEntry = entries.find((entry) => entry.action === 'attachment.send' && entry.ok === false);
  if (!attachmentAuditEntry) fail('invalid attachment send was not recorded as a failed audit entry');
  const attachmentAuditDetail = asObject(attachmentAuditEntry.detail, 'attachment.send audit detail');
  if (typeof attachmentAuditDetail.error !== 'string' || !attachmentAuditDetail.error.includes('path is required')) {
    fail('invalid attachment send audit entry missing path-required error');
  }

  const openPathAuditEntry = entries.find((entry) => entry.action === 'file.reveal' && entry.ok === false);
  if (!openPathAuditEntry) fail('invalid open-path was not recorded as a failed audit entry');
  const openPathAuditDetail = asObject(openPathAuditEntry.detail, 'file.reveal audit detail');
  if (typeof openPathAuditDetail.error !== 'string' || !openPathAuditDetail.error.includes('path or persona_doc is required')) {
    fail('invalid open-path audit entry missing path-required error');
  }

  const cronAuditEntry = entries.find((entry) => (
    entry.action === 'cron.delete'
    && entry.ok === false
    && entry.target === missingCronId
  ));
  if (!cronAuditEntry) fail('missing cron delete was not recorded as a failed audit entry');

  for (const action of ['cron.toggle', 'cron.run_now', 'cron.update']) {
    const entry = entries.find((item) => item.action === action && item.ok === false && item.target === missingCronId);
    if (!entry) fail(`missing ${action} was not recorded as a failed audit entry`);
  }

  const auditEntry = entries.find((entry) => (
    entry.action === 'web_session.close'
    && entry.ok === false
    && entry.target === missingRoutingKey
  ));
  if (!auditEntry) fail('missing web session close was not recorded as a failed audit entry');

  pass('mutation guards ok');
}

async function smokeReadModels(): Promise<void> {
  asArray(await readJson('/api/tasks?limit=5'), '/api/tasks');
  asArray(await readJson('/api/cron-jobs'), '/api/cron-jobs');

  const roles = asObject(await readJson('/api/persona/roles'), '/api/persona/roles');
  expectArrayProperty(roles, 'roles', '/api/persona/roles');

  const prompt = asObject(await readJson('/api/persona/prompt?role=director'), '/api/persona/prompt');
  if (typeof prompt.role !== 'string') fail('/api/persona/prompt missing role string');
  if (typeof prompt.baseInstructions !== 'string') fail('/api/persona/prompt missing baseInstructions string');
  if (typeof prompt.developerInstructions !== 'string') fail('/api/persona/prompt missing developerInstructions string');
  const promptFiles = asObject(prompt.files, '/api/persona/prompt.files');
  expectArrayProperty(promptFiles, 'base', '/api/persona/prompt.files');
  expectArrayProperty(promptFiles, 'developer', '/api/persona/prompt.files');

  const docs = asObject(await readJson('/api/persona/docs'), '/api/persona/docs');
  expectArrayProperty(docs, 'docs', '/api/persona/docs');
  const docList = docs.docs as Array<Record<string, unknown>>;
  const sampleDoc = docList.find((doc) => doc.path === 'TODO.md') || docList.find((doc) => typeof doc.path === 'string');
  if (sampleDoc && typeof sampleDoc.path === 'string') {
    const docContent = asObject(
      await readJson(`/api/persona/docs/content?path=${encodeURIComponent(sampleDoc.path)}`),
      '/api/persona/docs/content',
    );
    if (typeof docContent.content !== 'string') fail('/api/persona/docs/content missing content string');
  }

  const sessionLinks = asObject(await readJson('/api/persona/session-links'), '/api/persona/session-links');
  if (!sessionLinks.links || typeof sessionLinks.links !== 'object' || Array.isArray(sessionLinks.links)) {
    fail('/api/persona/session-links.links is not an object');
  }

  const state = asObject(await readJson('/api/state'), '/api/state');
  if (typeof state.state !== 'string' || typeof state.todo !== 'string') fail('/api/state missing state/todo strings');

  const files = asObject(await readJson('/api/files?scope=attachments'), '/api/files');
  expectArrayProperty(files, 'files', '/api/files');

  const logSources = asObject(await readJson('/api/logs/sources'), '/api/logs/sources');
  expectArrayProperty(logSources, 'sources', '/api/logs/sources');
  const sourceList = logSources.sources as Array<Record<string, unknown>>;
  const sampleSource = sourceList.find((source) => typeof source.id === 'string');
  if (sampleSource && typeof sampleSource.id === 'string') {
    const tail = asObject(
      await readJson(`/api/logs/tail?id=${encodeURIComponent(sampleSource.id)}&bytes=1024`),
      '/api/logs/tail',
    );
    if (typeof tail.content !== 'string') fail('/api/logs/tail missing content string');
  }

  const search = asObject(await readJson('/api/search?q=Director&limit=3'), '/api/search');
  expectArrayProperty(search, 'results', '/api/search');

  asObject(await readJson('/api/config-summary'), '/api/config-summary');
  asObject(await readJson('/api/config-assets'), '/api/config-assets');
  asObject(await readJson('/api/env-check'), '/api/env-check');
  asObject(await readJson('/api/observability/diagnostics'), '/api/observability/diagnostics');

  const debugBundle = asObject(await readJson('/api/debug-bundle'), '/api/debug-bundle');
  if (typeof debugBundle.generatedAt !== 'string') fail('/api/debug-bundle missing generatedAt string');
  asObject(debugBundle.snapshot, '/api/debug-bundle.snapshot');
  asObject(debugBundle.config, '/api/debug-bundle.config');
  expectArrayProperty(debugBundle, 'env', '/api/debug-bundle');
  const debugLogs = asObject(debugBundle.logs, '/api/debug-bundle.logs');
  expectArrayProperty(debugLogs, 'sources', '/api/debug-bundle.logs');
  if (!debugLogs.tails || typeof debugLogs.tails !== 'object' || Array.isArray(debugLogs.tails)) {
    fail('/api/debug-bundle.logs.tails is not an object');
  }
  expectArrayProperty(debugBundle, 'audit', '/api/debug-bundle');
  expectArrayProperty(debugBundle, 'tasks', '/api/debug-bundle');
  expectArrayProperty(debugBundle, 'cronJobs', '/api/debug-bundle');

  const audit = asObject(await readJson('/api/audit-log?limit=5'), '/api/audit-log');
  expectArrayProperty(audit, 'entries', '/api/audit-log');

  pass('read models ok');
}

async function assertDirectorHistory(directorLabel: string, required: boolean): Promise<boolean> {
  const directorSessions = asArray(
    await readJson(`/api/sessions?director=${encodeURIComponent(directorLabel)}`),
    `/api/sessions?director=${directorLabel}`,
  );
  if (directorSessions.length === 0) {
    if (required) fail(`director ${directorLabel} returned no sessions`);
    return false;
  }

  const firstSession = directorSessions.find((session) => typeof session.sessionId === 'string' && session.sessionId) || directorSessions[0];
  const sessionId = String(firstSession.sessionId || '');
  if (!sessionId) {
    if (required) fail(`director ${directorLabel} first session has no sessionId`);
    return false;
  }

  const messages = asArray(
    await readJson(`/api/messages?limit=5&director=${encodeURIComponent(directorLabel)}&sessionId=${encodeURIComponent(sessionId)}`),
    `/api/messages?director=${directorLabel}`,
  );
  if (messages.length === 0) {
    if (required) fail(`director ${directorLabel} session ${sessionId} returned no messages`);
    return false;
  }

  pass(`director ${directorLabel} sessions/messages ok`);
  return true;
}

async function smokeClosedDirectorHistory(): Promise<void> {
  const requestedDirector = process.env.PERSONA_SMOKE_DIRECTOR;
  if (requestedDirector) {
    await assertDirectorHistory(requestedDirector, true);
    return;
  }

  const sourcesPayload = await readJson('/api/logs/sources') as { sources?: Array<Record<string, unknown>> };
  const sources = Array.isArray(sourcesPayload.sources) ? sourcesPayload.sources : [];
  const groups = Array.from(new Set(
    sources
      .filter((source) => {
        const group = String(source.group || '');
        const id = String(source.id || '');
        return group && group !== 'main' && group !== 'shell' && /(^|\/)output-\d{8}\.log$/.test(id);
      })
      .map((source) => String(source.group || '')),
  ));

  if (groups.length === 0) {
    pass('closed director history: skipped (no director output logs)');
    return;
  }

  for (const group of groups.slice(0, 8)) {
    if (await assertDirectorHistory(group, false)) return;
  }

  fail(`closed director history candidates returned no readable messages: ${groups.slice(0, 8).join(', ')}`);
}

async function smokeSessions(): Promise<void> {
  const sessions = asArray(await readJson('/api/sessions'), '/api/sessions');
  pass(`main sessions: ${sessions.length}`);
  if (sessions.length > 0) {
    const first = sessions[0];
    const sessionId = String(first.sessionId || '');
    if (!sessionId) fail('first main session has no sessionId');
    const messages = asArray(await readJson(`/api/messages?limit=5&sessionId=${encodeURIComponent(sessionId)}`), '/api/messages');
    if (messages.length === 0) fail(`main session ${sessionId} returned no messages`);
    pass(`main session messages: ${messages.length}`);
  }

  await smokeClosedDirectorHistory();
}

async function chooseAttachmentPath(): Promise<string> {
  const payload = await readJson('/api/files?scope=attachments') as { files?: Array<Record<string, unknown>> };
  const files = Array.isArray(payload.files) ? payload.files : [];
  const chosen = files.find((file) => typeof file.path === 'string' && Number(file.size || 0) > 0);
  if (!chosen || typeof chosen.path !== 'string') fail('no attachment file available for send smoke');
  return chosen.path;
}

async function smokeWebAttachment(): Promise<void> {
  const path = process.env.PERSONA_SMOKE_ATTACHMENT || await chooseAttachmentPath();
  const ws = new WebSocket(wsUrl);
  let sawStatus = false;

  async function wsText(data: unknown): Promise<string> {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
    if (data instanceof Blob) return data.text();
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf-8');
    return String(data);
  }

  await new Promise<void>((resolve, reject) => {
    let sawAttachment = false;
    const timeout = setTimeout(() => reject(new Error('timeout waiting for status/chat_attachment')), 10_000);
    function maybeDone(): void {
      if (!sawStatus || !sawAttachment) return;
      clearTimeout(timeout);
      ws.close();
      resolve();
    }
    ws.onopen = async () => {
      try {
        setTimeout(async () => {
          try {
            const body = await postJson('/api/send-attachment', {
              path,
              source_director: 'main',
              target_channel: 'web',
            }) as { success?: boolean; delivery?: { path?: string; target_channel?: string } };
            if (!body.success) throw new Error('send-attachment did not return success');
            if (body.delivery?.target_channel !== 'web') throw new Error('send-attachment did not report web target_channel');
          } catch (err) {
            clearTimeout(timeout);
            reject(err);
          }
        }, 100);
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    };
    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(await wsText(event.data));
        if (msg.type === 'status') {
          const data = asObject(msg.data, 'websocket status.data');
          const system = asObject(data.system, 'websocket status.data.system');
          if (typeof system.status !== 'string') throw new Error('websocket status missing system.status');
          const activity = asObject(data.activity, 'websocket status.data.activity');
          if (typeof activity.state !== 'string') throw new Error('websocket status missing activity.state');
          asObject(data.context, 'websocket status.data.context');
          const tasks = asObject(data.tasks, 'websocket status.data.tasks');
          asObject(tasks.summary, 'websocket status.data.tasks.summary');
          if (!Array.isArray(data.queue)) throw new Error('websocket status.data.queue is not an array');
          if (!Array.isArray(data.pool)) throw new Error('websocket status.data.pool is not an array');
          if (!sawStatus) pass(`websocket status event: ${system.status}/${activity.state}`);
          sawStatus = true;
          maybeDone();
          return;
        }
        if (msg.type !== 'chat_attachment') return;
        if (!msg.file || msg.file.path !== path) throw new Error('chat_attachment payload path mismatch');
        pass(`web attachment event: ${msg.file.name || msg.file.path}`);
        sawAttachment = true;
        maybeDone();
      } catch (err) {
        clearTimeout(timeout);
        ws.close();
        reject(err);
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('websocket error'));
    };
  }).catch((err) => fail(String(err)));
}

await smokeFrontendShell();
await smokeSessions();
await smokeReadModels();
await smokeTaskAndFileDetails();
await smokeAutomationAndMaintenanceDetails();
await smokeMutationGuards();
await smokeWebAttachment();
pass('ok');

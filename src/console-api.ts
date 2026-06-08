export type SendApiPayload =
  | { ok: true; sessionId: string; text: string }
  | { ok: false; status: 400; message: string };

export function parseSendApiPayload(body: unknown): SendApiPayload {
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const text = typeof payload.text === 'string' ? payload.text : '';
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';

  if (!text.trim()) return { ok: false, status: 400, message: 'text is required' };
  if (!sessionId) return { ok: false, status: 400, message: 'sessionId is required' };

  return { ok: true, sessionId, text };
}

export function parseMessagesSessionId(url: URL): string | null {
  const sessionId = url.searchParams.get('sessionId')?.trim() ?? '';
  return sessionId || null;
}

export function parseSessionsWorkspace(url: URL): string {
  return url.searchParams.get('workspace')?.trim() || 'main';
}

import { resolve } from 'path';

export interface SendApiAttachmentPayload {
  type: 'image' | 'file' | 'audio';
  path: string;
  name?: string;
  mime?: string;
}

export type SendApiPayload =
  | { ok: true; sessionId: string; text: string; attachments?: SendApiAttachmentPayload[] }
  | { ok: false; status: 400; message: string };

export function parseSendApiPayload(body: unknown): SendApiPayload {
  const payload = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const text = typeof payload.text === 'string' ? payload.text : '';
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  const attachments = parseSendAttachments(payload.attachments);

  if (!text.trim() && attachments.length === 0) return { ok: false, status: 400, message: 'text or attachments is required' };
  if (!sessionId) return { ok: false, status: 400, message: 'sessionId is required' };

  return { ok: true, sessionId, text, ...(attachments.length ? { attachments } : {}) };
}

function parseSendAttachments(value: unknown): SendApiAttachmentPayload[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    if (!path) return [];
    const rawType = typeof record.type === 'string'
      ? record.type
      : typeof record.kind === 'string'
        ? record.kind
        : 'file';
    const type: SendApiAttachmentPayload['type'] = rawType === 'image' || rawType === 'audio' ? rawType : 'file';
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : undefined;
    const mime = typeof record.mime === 'string' && record.mime.trim() ? record.mime.trim() : undefined;
    return [{ type, path, ...(name ? { name } : {}), ...(mime ? { mime } : {}) }];
  });
}

export function parseMessagesSessionId(url: URL): string | null {
  const sessionId = url.searchParams.get('sessionId')?.trim() ?? '';
  return sessionId || null;
}

export function parseSessionsWorkspace(url: URL): string {
  return url.searchParams.get('workspace')?.trim() || 'main';
}

export function resolveAllowedProjectPath(
  rawPath: string | null,
  allowedRoots: string[],
  opts: { defaultRoot?: string; requireRoot?: boolean } = {},
): { root: string; path: string } | null {
  const roots = [...new Set(allowedRoots.map((root) => resolvePath(root)).filter(Boolean))];
  const raw = rawPath?.trim() ?? '';
  const requested = raw ? resolvePath(raw) : opts.defaultRoot ? resolvePath(opts.defaultRoot) : '';
  const root = roots.find((candidateRoot) => isInsidePath(candidateRoot, requested));
  if (!root) return null;
  if (opts.requireRoot && requested !== root) return null;
  return { root, path: requested };
}

function resolvePath(path: string): string {
  return resolve(path);
}

function isInsidePath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

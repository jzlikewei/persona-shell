import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, dirname, join, normalize, resolve } from 'path';

export interface PersonaRoleSummary {
  role: string;
  path: string;
  name: string | null;
  description: string | null;
}

export interface PersonaPromptBundle {
  role: string;
  baseInstructions: string;
  developerInstructions: string;
  files: {
    base: string[];
    developer: string[];
  };
}

export type PersonaMemoryScope = 'daily' | 'memory' | 'workspace' | 'session';

export interface PersonaSessionLink {
  channel: string;
  externalId: string;
  personaSessionId?: string | null;
  sessionId?: string | null;
  workspace?: string | null;
  codexThreadId?: string | null;
  /** @deprecated legacy runtime label; use sessionId/workspace. */
  directorLabel?: string | null;
  legacyDirectorLabel?: string | null;
  role?: string | null;
  updatedAt: string;
}

function readIfExists(path: string): string {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf-8').trim();
}

function parseFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---', 4);
  if (end === -1) return {};
  const raw = content.slice(4, end).trim();
  const result: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && value) result[key] = value;
  }
  return result;
}

function firstHeading(content: string): string | null {
  const line = content.split('\n').find((entry) => entry.startsWith('# '));
  return line ? line.replace(/^#\s+/, '').trim() : null;
}

function assertInside(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(resolvedRoot + '/')) {
    throw new Error(`path escapes persona directory: ${candidate}`);
  }
  return resolvedCandidate;
}

function safeRelative(value: string): string {
  const normalized = normalize(value);
  if (normalized.startsWith('..') || normalized.startsWith('/')) {
    throw new Error(`unsafe relative path: ${value}`);
  }
  return normalized;
}

export function listPersonaRoles(personaDir: string): PersonaRoleSummary[] {
  const rolesDir = join(personaDir, 'personas');
  if (!existsSync(rolesDir)) return [];
  return readdirSync(rolesDir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const path = join(rolesDir, file);
      const content = readIfExists(path);
      const meta = parseFrontmatter(content);
      return {
        role: basename(file, '.md'),
        path,
        name: meta.name ?? firstHeading(content),
        description: meta.description ?? null,
      };
    });
}

export function buildPersonaPromptBundle(
  personaDir: string,
  role: string,
  options?: { systemPromptFile?: string | null },
): PersonaPromptBundle {
  const baseFiles = ['CLAUDE.md', 'soul.md', 'meta.md'];
  const developerFiles = [
    ...(options?.systemPromptFile ? [options.systemPromptFile] : []),
    `personas/${role}.md`,
  ];
  const readSections = (files: string[]) => files
    .map((file) => readIfExists(join(personaDir, safeRelative(file))))
    .filter(Boolean)
    .join('\n\n');

  return {
    role,
    baseInstructions: readSections(baseFiles),
    developerInstructions: readSections(developerFiles),
    files: {
      base: baseFiles.map((file) => join(personaDir, file)).filter(existsSync),
      developer: developerFiles.map((file) => join(personaDir, safeRelative(file))).filter(existsSync),
    },
  };
}

export function resolvePersonaMemoryPath(personaDir: string, scope: PersonaMemoryScope, key?: string): string {
  const trimmedKey = key?.trim();
  switch (scope) {
    case 'daily':
      return assertInside(personaDir, join(personaDir, 'daily', safeRelative(trimmedKey || 'state.md')));
    case 'memory':
      return assertInside(personaDir, join(personaDir, 'memory', safeRelative(trimmedKey || 'MEMORY.md')));
    case 'workspace': {
      if (!trimmedKey) throw new Error('workspace key is required');
      let rel = safeRelative(trimmedKey);
      // Normalize legacy {hash}-{name} keys to {name}
      const legacyMatch = rel.match(/^[0-9a-f]{8}-(.+)$/i);
      if (legacyMatch) {
        const cleanName = legacyMatch[1];
        const cleanDir = join(personaDir, 'workspaces', cleanName);
        if (existsSync(cleanDir)) rel = cleanName;
      }
      const path = rel.endsWith('.md')
        ? join(personaDir, 'workspaces', rel)
        : join(personaDir, 'workspaces', rel, 'context.md');
      return assertInside(personaDir, path);
    }
    case 'session': {
      if (!trimmedKey) throw new Error('session key is required');
      const file = trimmedKey.endsWith('.md') ? trimmedKey : `${trimmedKey}.md`;
      return assertInside(personaDir, join(personaDir, 'state', 'sessions', safeRelative(file)));
    }
    default:
      throw new Error(`unsupported memory scope: ${scope}`);
  }
}

export function readPersonaMemory(personaDir: string, scope: PersonaMemoryScope, key?: string): { path: string; content: string } {
  const path = resolvePersonaMemoryPath(personaDir, scope, key);
  return { path, content: existsSync(path) ? readFileSync(path, 'utf-8') : '' };
}

export function writePersonaMemory(personaDir: string, scope: PersonaMemoryScope, key: string | undefined, content: string): { path: string } {
  const path = resolvePersonaMemoryPath(personaDir, scope, key);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf-8');
  return { path };
}

export function sessionLinkKey(channel: string, externalId: string): string {
  return `${channel.trim()}:${externalId.trim()}`;
}

export function upsertSessionLink(
  existing: Record<string, PersonaSessionLink> | null,
  input: Omit<PersonaSessionLink, 'updatedAt'>,
): Record<string, PersonaSessionLink> {
  const links = { ...(existing ?? {}) };
  const key = sessionLinkKey(input.channel, input.externalId);
  links[key] = {
    ...links[key],
    ...input,
    updatedAt: new Date().toISOString(),
  };
  return links;
}

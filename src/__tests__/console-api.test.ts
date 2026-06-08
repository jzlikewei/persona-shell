import { describe, expect, test } from 'bun:test';
import { parseMessagesSessionId, parseSendApiPayload, parseSessionsWorkspace } from '../console-api.js';

describe('console API contract', () => {
  test('send requires sessionId and text', () => {
    expect(parseSendApiPayload({ sessionId: 's-1', text: 'hello' })).toEqual({
      ok: true,
      sessionId: 's-1',
      text: 'hello',
    });

    expect(parseSendApiPayload({ text: 'hello' })).toEqual({
      ok: false,
      status: 400,
      message: 'sessionId is required',
    });

    expect(parseSendApiPayload({ sessionId: 's-1', text: '   ' })).toEqual({
      ok: false,
      status: 400,
      message: 'text is required',
    });
  });

  test('send ignores legacy director routing fields', () => {
    expect(parseSendApiPayload({ director: 'main', director_label: 'main', text: 'hello' })).toEqual({
      ok: false,
      status: 400,
      message: 'sessionId is required',
    });
  });

  test('messages require sessionId and ignore director query', () => {
    expect(parseMessagesSessionId(new URL('http://local/api/messages?sessionId=s-1&director=main'))).toBe('s-1');
    expect(parseMessagesSessionId(new URL('http://local/api/messages?director=main'))).toBeNull();
    expect(parseMessagesSessionId(new URL('http://local/api/messages?session=old-session'))).toBeNull();
  });

  test('sessions use workspace query and default to main', () => {
    expect(parseSessionsWorkspace(new URL('http://local/api/sessions?workspace=project-a&director=old'))).toBe('project-a');
    expect(parseSessionsWorkspace(new URL('http://local/api/sessions?director=old'))).toBe('main');
  });
});

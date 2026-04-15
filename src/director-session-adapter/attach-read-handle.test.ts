import { describe, expect, test } from 'bun:test';
import { Readable } from 'stream';
import { attachReadHandle } from './index.js';
import type { FileHandle } from 'fs/promises';

/**
 * Create a fake FileHandle whose createReadStream returns a controllable Readable.
 */
function createFakeReadHandle(chunks: string[]): { handle: FileHandle; stream: Readable } {
  const stream = new Readable({
    read() {
      for (const chunk of chunks) {
        this.push(chunk);
      }
      this.push(null); // end stream
    },
  });

  const handle = {
    createReadStream: () => stream,
  } as unknown as FileHandle;

  return { handle, stream };
}

describe('attachReadHandle', () => {
  test('parses complete lines from stream', async () => {
    const lines: string[] = [];
    let closed = false;

    const { handle } = createFakeReadHandle(['line1\nline2\nline3\n']);

    attachReadHandle(handle, {
      onLine: (line) => lines.push(line),
      onClose: () => { closed = true; },
    });

    // Wait for stream to finish
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(lines).toEqual(['line1', 'line2', 'line3']);
    expect(closed).toBe(true);
  });

  test('handles lines split across multiple chunks', async () => {
    const lines: string[] = [];

    const { handle } = createFakeReadHandle(['hel', 'lo\nwor', 'ld\n']);

    attachReadHandle(handle, {
      onLine: (line) => lines.push(line),
      onClose: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(lines).toEqual(['hello', 'world']);
  });

  test('skips empty lines', async () => {
    const lines: string[] = [];

    const { handle } = createFakeReadHandle(['line1\n\n\nline2\n']);

    attachReadHandle(handle, {
      onLine: (line) => lines.push(line),
      onClose: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(lines).toEqual(['line1', 'line2']);
  });

  test('handles Buffer chunks', async () => {
    const lines: string[] = [];

    const stream = new Readable({
      read() {
        this.push(Buffer.from('buffered\n'));
        this.push(null);
      },
    });
    const handle = { createReadStream: () => stream } as unknown as FileHandle;

    attachReadHandle(handle, {
      onLine: (line) => lines.push(line),
      onClose: () => {},
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(lines).toEqual(['buffered']);
  });

  test('calls onClose when stream ends', async () => {
    let closed = false;

    const { handle } = createFakeReadHandle(['done\n']);

    attachReadHandle(handle, {
      onLine: () => {},
      onClose: () => { closed = true; },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(closed).toBe(true);
  });
});

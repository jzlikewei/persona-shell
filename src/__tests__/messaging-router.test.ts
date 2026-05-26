import { describe, expect, test } from 'bun:test';
import { MessagingRouter } from '../messaging/messaging-router.js';
import type {
  IncomingMessage,
  MessageHandler,
  MessagingClient,
  StreamingReplyHandle,
} from '../messaging/messaging.js';

class FakeStreamingReply implements StreamingReplyHandle {
  chunks: string[] = [];
  finalText: string | null = null;
  abortText: string | undefined;

  append(text: string): void {
    this.chunks.push(text);
  }

  async final(text: string): Promise<void> {
    this.finalText = text;
  }

  async abort(text?: string): Promise<void> {
    this.abortText = text;
  }
}

class FakeClient implements MessagingClient {
  handler: MessageHandler | null = null;
  streamingStartedFor: string[] = [];
  lastHandle: FakeStreamingReply | null = null;

  start(): void {}

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  emitMessage(msg: IncomingMessage): void {
    this.handler?.(msg);
  }

  async reply(): Promise<void> {}

  async sendMessage(): Promise<string | null> {
    return null;
  }

  async startStreamingReply(messageId: string): Promise<StreamingReplyHandle | null> {
    this.streamingStartedFor.push(messageId);
    this.lastHandle = new FakeStreamingReply();
    return this.lastHandle;
  }

  async addReaction(): Promise<void> {}

  async uploadAndReplyImage(): Promise<void> {}

  async uploadAndReplyFile(): Promise<void> {}

  async uploadAndSendImage(): Promise<string | null> {
    return null;
  }

  async uploadAndSendFile(): Promise<string | null> {
    return null;
  }

  getLastChatId(): string | null {
    return null;
  }

  getConnectionStatus(): 'connected' | 'disconnected' {
    return 'connected';
  }
}

function makeIncoming(messageId: string): IncomingMessage {
  return {
    text: 'hello',
    messageId,
    chatId: 'chat-1',
    chatType: 'p2p',
  };
}

describe('MessagingRouter streaming replies', () => {
  test('routes streaming reply creation to the inbound message origin client', async () => {
    const primary = new FakeClient();
    const secondary = new FakeClient();
    const router = new MessagingRouter(primary);
    router.addClient(secondary);
    router.onMessage(() => {});

    secondary.emitMessage(makeIncoming('msg-secondary'));

    const handle = await router.startStreamingReply('msg-secondary');

    expect(handle).toBe(secondary.lastHandle);
    expect(secondary.streamingStartedFor).toEqual(['msg-secondary']);
    expect(primary.streamingStartedFor).toEqual([]);
  });

  test('falls back to primary client for unknown message IDs', async () => {
    const primary = new FakeClient();
    const router = new MessagingRouter(primary);

    const handle = await router.startStreamingReply('msg-unknown');

    expect(handle).toBe(primary.lastHandle);
    expect(primary.streamingStartedFor).toEqual(['msg-unknown']);
  });
});

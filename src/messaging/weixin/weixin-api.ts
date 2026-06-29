import type {
  WeixinApiConfig,
  WeixinAccountCredentials,
  BaseInfo,
  GetUpdatesResponse,
  SendMessagePayload,
  SendMessageResponse,
  QrCodeResponse,
  QrCodeStatusResponse,
  GetConfigResponse,
} from './weixin-types.js';
import { DEFAULT_ILINK_BOT_TYPE } from './weixin-types.js';

export class WeixinApi {
  private config: WeixinApiConfig;

  constructor(config: WeixinApiConfig) {
    this.config = config;
  }

  private buildBaseInfo(): BaseInfo {
    return { bot_agent: this.config.botAgent };
  }

  private buildHeaders(creds?: WeixinAccountCredentials): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'iLink-App-Id': this.config.appId,
      'iLink-App-ClientVersion': this.config.clientVersion,
    };
    if (creds) {
      headers['AuthorizationType'] = 'Bearer';
      headers['Authorization'] = creds.token;
      headers['X-WECHAT-UIN'] = creds.userId;
    }
    return headers;
  }

  // ── Login ──

  async getQrCode(baseUrl?: string): Promise<QrCodeResponse> {
    const url = `${baseUrl ?? this.config.defaultBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_ILINK_BOT_TYPE}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ base_info: this.buildBaseInfo() }),
    });
    return res.json() as Promise<QrCodeResponse>;
  }

  async getQrCodeStatus(qrcodeId: string, baseUrl?: string): Promise<QrCodeStatusResponse> {
    const url = `${baseUrl ?? this.config.defaultBaseUrl}/ilink/bot/get_qrcode_status`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({
        base_info: this.buildBaseInfo(),
        qrcode_id: qrcodeId,
      }),
    });
    return res.json() as Promise<QrCodeStatusResponse>;
  }

  // ── Messaging ──

  async getUpdates(
    creds: WeixinAccountCredentials,
    getUpdatesBuf: unknown,
    signal?: AbortSignal,
  ): Promise<GetUpdatesResponse> {
    const url = `${creds.baseUrl}/ilink/bot/getupdates`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(creds),
      body: JSON.stringify({
        base_info: this.buildBaseInfo(),
        get_updates_buf: getUpdatesBuf ?? {},
      }),
      signal,
    });
    return res.json() as Promise<GetUpdatesResponse>;
  }

  async sendMessage(
    creds: WeixinAccountCredentials,
    payload: SendMessagePayload,
  ): Promise<SendMessageResponse> {
    const url = `${creds.baseUrl}/ilink/bot/sendmessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(creds),
      body: JSON.stringify(payload),
    });
    return res.json() as Promise<SendMessageResponse>;
  }

  // ── Lifecycle ──

  async notifyStart(creds: WeixinAccountCredentials): Promise<void> {
    const url = `${creds.baseUrl}/ilink/bot/notifystart`;
    await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(creds),
      body: JSON.stringify({ base_info: this.buildBaseInfo() }),
    }).catch(() => {});
  }

  async notifyStop(creds: WeixinAccountCredentials): Promise<void> {
    const url = `${creds.baseUrl}/ilink/bot/notifystop`;
    await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(creds),
      body: JSON.stringify({ base_info: this.buildBaseInfo() }),
    }).catch(() => {});
  }

  // ── Phase 2: Typing ──

  async getConfig(creds: WeixinAccountCredentials, userId: string): Promise<GetConfigResponse> {
    const url = `${creds.baseUrl}/ilink/bot/getconfig`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(creds),
      body: JSON.stringify({
        base_info: this.buildBaseInfo(),
        user_id: userId,
      }),
    });
    return res.json() as Promise<GetConfigResponse>;
  }

  async sendTyping(creds: WeixinAccountCredentials, userId: string, ticket: string): Promise<void> {
    const url = `${creds.baseUrl}/ilink/bot/sendtyping`;
    await fetch(url, {
      method: 'POST',
      headers: this.buildHeaders(creds),
      body: JSON.stringify({
        base_info: this.buildBaseInfo(),
        user_id: userId,
        typing_ticket: ticket,
        action: 1,
      }),
    }).catch(() => {});
  }
}

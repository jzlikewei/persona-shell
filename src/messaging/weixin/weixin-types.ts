// Derived from @tencent-weixin/openclaw-weixin 2.4.x protocol specification

// ── Item types ──
export const ITEM_TYPE_TEXT = 1;
export const ITEM_TYPE_IMAGE = 2;
export const ITEM_TYPE_FILE = 3;
export const ITEM_TYPE_VOICE = 4;

// ── Message types ──
export const MESSAGE_TYPE_BOT = 2;

// ── Message states ──
export const MESSAGE_STATE_GENERATING = 1;
export const MESSAGE_STATE_FINISH = 2;

// ── Error codes ──
export const SESSION_EXPIRED_ERRCODE = -14;

// ── Login states ──
export type LoginStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

// ── Default bot type for QR login ──
export const DEFAULT_ILINK_BOT_TYPE = 3;

// ── API types ──

export interface BaseInfo {
  bot_agent: string;
}

export interface TextItem {
  text: string;
}

export interface ImageItem {
  cdn_url: string;
  aes_key: string;
  file_id: string;
}

export interface FileItem {
  cdn_url: string;
  aes_key: string;
  file_name: string;
  file_size: number;
}

export interface VoiceItem {
  cdn_url: string;
  aes_key: string;
  duration: number;
  text?: string;
}

export interface MessageItem {
  type: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  file_item?: FileItem;
  voice_item?: VoiceItem;
}

export interface WeixinInboundMessage {
  message_id: string;
  from_user_id: string;
  to_user_id: string;
  message_type: number;
  message_state: number;
  item_list: MessageItem[];
  context_token: string;
  seq: number;
  client_id?: string;
  create_time_ms?: number;
  group_id?: string;
  quote_message?: {
    item_list: MessageItem[];
  };
}

export interface GetUpdatesResponse {
  errcode: number;
  errmsg?: string;
  get_updates_buf?: unknown;
  msg_list?: WeixinInboundMessage[];
}

export interface SendMessagePayload {
  base_info: BaseInfo;
  msg: {
    from_user_id: string;
    to_user_id: string;
    client_id: string;
    message_type: number;
    message_state: number;
    item_list: MessageItem[];
    context_token: string;
  };
}

export interface SendMessageResponse {
  errcode: number;
  errmsg?: string;
  message_id?: string;
}

export interface QrCodeResponse {
  errcode: number;
  errmsg?: string;
  qrcode_url?: string;
  qrcode_id?: string;
}

export interface QrCodeStatusResponse {
  errcode: number;
  errmsg?: string;
  status: LoginStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface GetConfigResponse {
  errcode: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface WeixinAccountCredentials {
  token: string;
  userId: string;
  baseUrl: string;
}

export interface WeixinApiConfig {
  defaultBaseUrl: string;
  botAgent: string;
  appId: string;
  clientVersion: string;
}

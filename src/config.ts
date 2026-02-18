import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { normalizePhone } from './utils.js';

export interface AppConfig {
  sendblue: {
    apiKey: string;
    apiSecret: string;
    phoneNumber: string;
    apiBase: string;
    pollIntervalMs: number;
  };
  bridge: {
    enableTypingIndicators: boolean;
    enableReadReceipts: boolean;
    enableOutboundUnicodeFormatting: boolean;
    discardBacklogOnStart: boolean;
    inboundMediaMode: 'url_only';
    typingHeartbeatMs: number;
  };
  notifications: {
    enabled: boolean;
    rawExcerptBytes: number;
    retentionDays: number;
    maxRows: number;
    heartbeatSourceEnabled: boolean;
    webhook: {
      enabled: boolean;
      host: string;
      port: number;
      path: string;
      secret: string;
    };
  };
  trustedPhoneNumber: string;
  codex: {
    bin: string;
    cwd: string;
    modelPrefix: string;
    defaultModel: string;
  };
  stateDbPath: string;
}

const envSchema = z.object({
  SENDBLUE_API_KEY: z.string().min(1),
  SENDBLUE_API_SECRET: z.string().min(1),
  SENDBLUE_PHONE_NUMBER: z.string().min(1),
  TRUSTED_PHONE_NUMBER: z.string().min(1),
  SENDBLUE_API_BASE: z.string().url().default('https://api.sendblue.co/api'),
  POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(30000).default(3000),
  CODEX_BIN: z.string().min(1).default('codex'),
  CODEX_CWD: z.string().min(1).default(process.cwd()),
  CODEX_MODEL_PREFIX: z.string().min(1).default('gpt-5.3-codex'),
  CODEX_MODEL: z.string().min(1).default('gpt-5.3-codex'),
  STATE_DB_PATH: z.string().min(1).default(resolve(homedir(), '.imessage-codex-bridge', 'state.db')),
  ENABLE_TYPING_INDICATORS: z
    .enum(['0', '1', 'true', 'false'])
    .default('1')
    .transform((value) => value === '1' || value === 'true'),
  ENABLE_READ_RECEIPTS: z
    .enum(['0', '1', 'true', 'false'])
    .default('1')
    .transform((value) => value === '1' || value === 'true'),
  ENABLE_OUTBOUND_UNICODE_FORMATTING: z
    .enum(['0', '1', 'true', 'false'])
    .default('1')
    .transform((value) => value === '1' || value === 'true'),
  DISCARD_BACKLOG_ON_START: z
    .enum(['0', '1', 'true', 'false'])
    .default('1')
    .transform((value) => value === '1' || value === 'true'),
  INBOUND_MEDIA_MODE: z.enum(['url_only']).default('url_only'),
  TYPING_HEARTBEAT_MS: z.coerce.number().int().min(3000).max(30000).default(10000),
  ENABLE_NOTIFICATION_TURNS: z
    .enum(['0', '1', 'true', 'false'])
    .default('1')
    .transform((value) => value === '1' || value === 'true'),
  NOTIFICATION_RAW_EXCERPT_BYTES: z.coerce.number().int().min(256).max(32768).default(4096),
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  NOTIFICATION_MAX_ROWS: z.coerce.number().int().min(100).max(1_000_000).default(25000),
  ENABLE_HEARTBEAT_SOURCE: z
    .enum(['0', '1', 'true', 'false'])
    .default('0')
    .transform((value) => value === '1' || value === 'true'),
  ENABLE_NOTIFICATION_WEBHOOK: z
    .enum(['0', '1', 'true', 'false'])
    .default('1')
    .transform((value) => value === '1' || value === 'true'),
  NOTIFICATION_WEBHOOK_HOST: z.string().min(1).default('0.0.0.0'),
  NOTIFICATION_WEBHOOK_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  NOTIFICATION_WEBHOOK_PATH: z
    .string()
    .min(1)
    .default('/events')
    .transform((value) => (value.startsWith('/') ? value : `/${value}`)),
  NOTIFICATION_WEBHOOK_SECRET: z.string().default(''),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  const trustedPhoneNumber = normalizePhone(parsed.TRUSTED_PHONE_NUMBER);
  const sendbluePhoneNumber = normalizePhone(parsed.SENDBLUE_PHONE_NUMBER);

  if (trustedPhoneNumber.length === 0) {
    throw new Error('TRUSTED_PHONE_NUMBER must contain at least one digit');
  }
  if (sendbluePhoneNumber.length === 0) {
    throw new Error('SENDBLUE_PHONE_NUMBER must contain at least one digit');
  }
  if (!parsed.CODEX_MODEL.startsWith(parsed.CODEX_MODEL_PREFIX)) {
    throw new Error(
      `CODEX_MODEL (${parsed.CODEX_MODEL}) must start with CODEX_MODEL_PREFIX (${parsed.CODEX_MODEL_PREFIX})`,
    );
  }
  if (parsed.ENABLE_NOTIFICATION_WEBHOOK && parsed.NOTIFICATION_WEBHOOK_SECRET.trim().length === 0) {
    throw new Error('NOTIFICATION_WEBHOOK_SECRET is required when ENABLE_NOTIFICATION_WEBHOOK is enabled');
  }

  return {
    sendblue: {
      apiKey: parsed.SENDBLUE_API_KEY,
      apiSecret: parsed.SENDBLUE_API_SECRET,
      phoneNumber: sendbluePhoneNumber,
      apiBase: parsed.SENDBLUE_API_BASE,
      pollIntervalMs: parsed.POLL_INTERVAL_MS,
    },
    bridge: {
      enableTypingIndicators: parsed.ENABLE_TYPING_INDICATORS,
      enableReadReceipts: parsed.ENABLE_READ_RECEIPTS,
      enableOutboundUnicodeFormatting: parsed.ENABLE_OUTBOUND_UNICODE_FORMATTING,
      discardBacklogOnStart: parsed.DISCARD_BACKLOG_ON_START,
      inboundMediaMode: parsed.INBOUND_MEDIA_MODE,
      typingHeartbeatMs: parsed.TYPING_HEARTBEAT_MS,
    },
    notifications: {
      enabled: parsed.ENABLE_NOTIFICATION_TURNS,
      rawExcerptBytes: parsed.NOTIFICATION_RAW_EXCERPT_BYTES,
      retentionDays: parsed.NOTIFICATION_RETENTION_DAYS,
      maxRows: parsed.NOTIFICATION_MAX_ROWS,
      heartbeatSourceEnabled: parsed.ENABLE_HEARTBEAT_SOURCE,
      webhook: {
        enabled: parsed.ENABLE_NOTIFICATION_WEBHOOK,
        host: parsed.NOTIFICATION_WEBHOOK_HOST,
        port: parsed.NOTIFICATION_WEBHOOK_PORT,
        path: parsed.NOTIFICATION_WEBHOOK_PATH,
        secret: parsed.NOTIFICATION_WEBHOOK_SECRET.trim(),
      },
    },
    trustedPhoneNumber,
    codex: {
      bin: parsed.CODEX_BIN,
      cwd: parsed.CODEX_CWD,
      modelPrefix: parsed.CODEX_MODEL_PREFIX,
      defaultModel: parsed.CODEX_MODEL,
    },
    stateDbPath: parsed.STATE_DB_PATH,
  };
}

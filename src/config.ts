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
  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(30000).default(3000),
  CODEX_BIN: z.string().min(1).default('codex'),
  CODEX_CWD: z.string().min(1).default(process.cwd()),
  CODEX_MODEL_PREFIX: z.string().min(1).default('gpt-5.3-codex'),
  CODEX_MODEL: z.string().min(1).default('gpt-5.3-codex'),
  STATE_DB_PATH: z.string().min(1).default(resolve(homedir(), '.imessage-codex-bridge', 'state.db')),
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

  return {
    sendblue: {
      apiKey: parsed.SENDBLUE_API_KEY,
      apiSecret: parsed.SENDBLUE_API_SECRET,
      phoneNumber: sendbluePhoneNumber,
      apiBase: parsed.SENDBLUE_API_BASE,
      pollIntervalMs: parsed.POLL_INTERVAL_MS,
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

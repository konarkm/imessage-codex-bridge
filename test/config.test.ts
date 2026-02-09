import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('normalizes phone numbers and validates model prefix', () => {
    const config = loadConfig({
      SENDBLUE_API_KEY: 'k',
      SENDBLUE_API_SECRET: 's',
      SENDBLUE_PHONE_NUMBER: '+1 (555) 111-2222',
      TRUSTED_PHONE_NUMBER: '(555)333-4444',
      CODEX_MODEL_PREFIX: 'gpt-5.3-codex',
      CODEX_MODEL: 'gpt-5.3-codex',
      CODEX_CWD: '/tmp',
      CODEX_BIN: 'codex',
      POLL_INTERVAL_MS: '3000',
      SENDBLUE_API_BASE: 'https://api.sendblue.com/api',
      STATE_DB_PATH: '/tmp/test-state.db',
    });

    expect(config.sendblue.phoneNumber).toBe('+15551112222');
    expect(config.trustedPhoneNumber).toBe('+5553334444');
    expect(config.codex.defaultModel).toBe('gpt-5.3-codex');
  });

  it('throws when model does not match prefix', () => {
    expect(() =>
      loadConfig({
        SENDBLUE_API_KEY: 'k',
        SENDBLUE_API_SECRET: 's',
        SENDBLUE_PHONE_NUMBER: '+15551112222',
        TRUSTED_PHONE_NUMBER: '+15553334444',
        CODEX_MODEL_PREFIX: 'gpt-5.3-codex',
        CODEX_MODEL: 'gpt-5.2-codex',
      }),
    ).toThrow(/CODEX_MODEL/);
  });
});

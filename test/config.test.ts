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
      ENABLE_TYPING_INDICATORS: '1',
      ENABLE_READ_RECEIPTS: '1',
      ENABLE_OUTBOUND_UNICODE_FORMATTING: '1',
      DISCARD_BACKLOG_ON_START: '1',
      INBOUND_MEDIA_MODE: 'url_only',
      TYPING_HEARTBEAT_MS: '10000',
    });

    expect(config.sendblue.phoneNumber).toBe('+15551112222');
    expect(config.trustedPhoneNumber).toBe('+5553334444');
    expect(config.codex.defaultModel).toBe('gpt-5.3-codex');
    expect(config.bridge.enableTypingIndicators).toBe(true);
    expect(config.bridge.enableReadReceipts).toBe(true);
    expect(config.bridge.enableOutboundUnicodeFormatting).toBe(true);
    expect(config.bridge.discardBacklogOnStart).toBe(true);
    expect(config.bridge.inboundMediaMode).toBe('url_only');
    expect(config.bridge.typingHeartbeatMs).toBe(10000);
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

  it('parses bridge feature flags', () => {
    const config = loadConfig({
      SENDBLUE_API_KEY: 'k',
      SENDBLUE_API_SECRET: 's',
      SENDBLUE_PHONE_NUMBER: '+15551112222',
      TRUSTED_PHONE_NUMBER: '+15553334444',
      CODEX_MODEL_PREFIX: 'gpt-5.3-codex',
      CODEX_MODEL: 'gpt-5.3-codex',
      ENABLE_TYPING_INDICATORS: 'false',
      ENABLE_READ_RECEIPTS: '0',
      ENABLE_OUTBOUND_UNICODE_FORMATTING: 'false',
      DISCARD_BACKLOG_ON_START: 'false',
      INBOUND_MEDIA_MODE: 'url_only',
      TYPING_HEARTBEAT_MS: '9000',
    });

    expect(config.bridge.enableTypingIndicators).toBe(false);
    expect(config.bridge.enableReadReceipts).toBe(false);
    expect(config.bridge.enableOutboundUnicodeFormatting).toBe(false);
    expect(config.bridge.discardBacklogOnStart).toBe(false);
    expect(config.bridge.typingHeartbeatMs).toBe(9000);
  });
});

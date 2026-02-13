import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const baseEnv: Record<string, string> = {
  SENDBLUE_API_KEY: 'k',
  SENDBLUE_API_SECRET: 's',
  SENDBLUE_PHONE_NUMBER: '+15551112222',
  TRUSTED_PHONE_NUMBER: '+15553334444',
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
  ENABLE_NOTIFICATION_WEBHOOK: '0',
};

describe('loadConfig', () => {
  it('normalizes phone numbers and validates model prefix', () => {
    const config = loadConfig({
      ...baseEnv,
      SENDBLUE_PHONE_NUMBER: '+1 (555) 111-2222',
      TRUSTED_PHONE_NUMBER: '(555)333-4444',
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
        ...baseEnv,
        CODEX_MODEL: 'gpt-5.2-codex',
      }),
    ).toThrow(/CODEX_MODEL/);
  });

  it('parses bridge feature flags', () => {
    const config = loadConfig({
      ...baseEnv,
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

  it('requires webhook secret when webhook ingress is enabled', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        ENABLE_NOTIFICATION_WEBHOOK: '1',
        NOTIFICATION_WEBHOOK_SECRET: '',
      }),
    ).toThrow(/NOTIFICATION_WEBHOOK_SECRET/);
  });

  it('parses notification config', () => {
    const config = loadConfig({
      ...baseEnv,
      ENABLE_NOTIFICATION_TURNS: '1',
      NOTIFICATION_RAW_EXCERPT_BYTES: '4096',
      NOTIFICATION_RETENTION_DAYS: '120',
      NOTIFICATION_MAX_ROWS: '40000',
      ENABLE_HEARTBEAT_SOURCE: '0',
      ENABLE_NOTIFICATION_WEBHOOK: '1',
      NOTIFICATION_WEBHOOK_SECRET: 'secret',
      NOTIFICATION_WEBHOOK_HOST: '127.0.0.1',
      NOTIFICATION_WEBHOOK_PORT: '8788',
      NOTIFICATION_WEBHOOK_PATH: 'hook',
    });

    expect(config.notifications.enabled).toBe(true);
    expect(config.notifications.rawExcerptBytes).toBe(4096);
    expect(config.notifications.retentionDays).toBe(120);
    expect(config.notifications.maxRows).toBe(40000);
    expect(config.notifications.heartbeatSourceEnabled).toBe(false);
    expect(config.notifications.webhook.enabled).toBe(true);
    expect(config.notifications.webhook.path).toBe('/hook');
  });
});

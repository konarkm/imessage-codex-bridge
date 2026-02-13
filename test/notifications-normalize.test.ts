import { describe, expect, it } from 'vitest';
import { normalizeNotification } from '../src/notifications/normalize.js';

describe('normalizeNotification', () => {
  it('uses source event id dedupe key when available', () => {
    const event = normalizeNotification({
      payload: {
        event_id: 'evt_123',
        summary: 'Build failed',
      },
      source: 'webhook',
      sourceAccount: 'acme',
      receivedAtMs: 1234,
      rawExcerptBytes: 4096,
    });

    expect(event.sourceEventId).toBe('evt_123');
    expect(event.dedupeKey).toBe('event:webhook:acme:evt_123');
    expect(event.summary).toBe('Build failed');
    expect(event.status).toBe('queued');
  });

  it('falls back to hash dedupe key when source event id is missing', () => {
    const event = normalizeNotification({
      payload: {
        a: 1,
        b: 'x',
      },
      source: 'webhook',
      sourceAccount: 'acme',
      receivedAtMs: 1234,
      rawExcerptBytes: 4096,
    });

    expect(event.sourceEventId).toBeNull();
    expect(event.dedupeKey.startsWith('hash:webhook:acme:')).toBe(true);
  });

  it('tracks excerpt truncation metadata', () => {
    const payload = { text: 'x'.repeat(5000) };
    const event = normalizeNotification({
      payload,
      rawExcerptBytes: 1024,
    });

    expect(event.rawTruncated).toBe(true);
    expect(event.rawSizeBytes).toBeGreaterThan(1024);
    expect(Buffer.byteLength(event.rawExcerpt, 'utf8')).toBeLessThanOrEqual(1024);
  });
});

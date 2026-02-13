import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeNotification } from '../src/notifications/normalize.js';
import { StateStore } from '../src/state/store.js';

function newDbPath(): string {
  return join(tmpdir(), `imessage-codex-bridge-notification-test-${Date.now()}-${Math.random()}.db`);
}

describe('StateStore notifications', () => {
  it('deduplicates by dedupe key and increments duplicate count', () => {
    const dbPath = newDbPath();
    const store = new StateStore(dbPath, 'gpt-5.3-codex');
    const first = normalizeNotification({
      payload: { event_id: 'evt_1', summary: 'hello' },
      source: 'webhook',
      sourceAccount: 'acct',
      receivedAtMs: 1000,
    });

    const second = normalizeNotification({
      payload: { event_id: 'evt_1', summary: 'hello again' },
      source: 'webhook',
      sourceAccount: 'acct',
      receivedAtMs: 2000,
    });

    const firstResult = store.appendNotification(first);
    const secondResult = store.appendNotification(second);
    expect(firstResult.inserted).toBe(true);
    expect(secondResult.inserted).toBe(false);
    expect(secondResult.id).toBe(first.id);

    const row = store.getNotificationById(first.id);
    expect(row).not.toBeNull();
    expect(row?.duplicateCount).toBe(1);

    store.close();
    rmSync(dbPath, { force: true });
  });

  it('claims queued notifications and marks processing', () => {
    const dbPath = newDbPath();
    const store = new StateStore(dbPath, 'gpt-5.3-codex');

    const event = normalizeNotification({
      payload: { summary: 'hello' },
      source: 'webhook',
      receivedAtMs: 1000,
    });
    store.appendNotification(event);

    const claimed = store.claimNextQueuedNotification();
    expect(claimed?.id).toBe(event.id);
    expect(claimed?.status).toBe('processing');

    store.close();
    rmSync(dbPath, { force: true });
  });

  it('prunes by window then row cap', () => {
    const dbPath = newDbPath();
    const store = new StateStore(dbPath, 'gpt-5.3-codex');

    const now = 10 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 6; i += 1) {
      const event = normalizeNotification({
        payload: { event_id: `evt_${i}`, summary: `n${i}` },
        source: 'webhook',
        receivedAtMs: now - i * 24 * 60 * 60 * 1000,
      });
      store.appendNotification(event);
    }

    const pruned = store.pruneNotifications(now, 3, 2);
    expect(pruned).toBeGreaterThan(0);
    const remaining = store.listNotifications({ count: 50, source: 'all' });
    expect(remaining.length).toBeLessThanOrEqual(2);

    store.close();
    rmSync(dbPath, { force: true });
  });
});

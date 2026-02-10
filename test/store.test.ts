import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/state/store.js';

function newDbPath(): string {
  return join(tmpdir(), `imessage-codex-bridge-test-${Date.now()}-${Math.random()}.db`);
}

describe('StateStore', () => {
  it('tracks dedupe flags and session state', () => {
    const dbPath = newDbPath();
    const store = new StateStore(dbPath, 'gpt-5.3-codex');

    const session = store.getSession('15551234567');
    expect(session.threadId).toBeNull();
    expect(session.activeTurnId).toBeNull();
    expect(session.model).toBe('gpt-5.3-codex');

    expect(store.markMessageProcessed('m1')).toBe(true);
    expect(store.markMessageProcessed('m1')).toBe(false);
    expect(store.hasProcessedMessages()).toBe(true);
    expect(store.markMessagesProcessed(['m1', 'm2', 'm3'])).toBe(2);
    expect(store.markMessageProcessed('m2')).toBe(false);

    store.setThreadId('15551234567', 'thr_1');
    store.setActiveTurn('15551234567', 'turn_1');
    const updated = store.getSession('15551234567');
    expect(updated.threadId).toBe('thr_1');
    expect(updated.activeTurnId).toBe('turn_1');

    const flags = store.getFlags();
    expect(flags.autoApprove).toBe(true);
    expect(flags.paused).toBe(false);

    store.setPaused(true);
    store.setAutoApprove(false);
    const changed = store.getFlags();
    expect(changed.paused).toBe(true);
    expect(changed.autoApprove).toBe(false);

    store.close();
    rmSync(dbPath, { force: true });
  });
});

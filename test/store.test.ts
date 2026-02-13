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

    expect(store.getReasoningEffortForModel('gpt-5.3-codex')).toBe('medium');
    expect(store.getReasoningEffortForModel('gpt-5.3-codex-spark')).toBe('xhigh');
    store.setReasoningEffortForModel('gpt-5.3-codex', 'low');
    store.setReasoningEffortForModel('gpt-5.3-codex-spark', 'high');
    expect(store.getReasoningEffortForModel('gpt-5.3-codex')).toBe('low');
    expect(store.getReasoningEffortForModel('gpt-5.3-codex-spark')).toBe('high');

    expect(store.getSparkReturnTarget()).toBeNull();
    store.setSparkReturnTarget({ model: 'gpt-5.3-codex', effort: 'low' });
    expect(store.getSparkReturnTarget()).toEqual({ model: 'gpt-5.3-codex', effort: 'low' });
    store.clearSparkReturnTarget();
    expect(store.getSparkReturnTarget()).toBeNull();

    expect(store.consumePendingBridgeRestartNotice()).toBeNull();
    store.setPendingBridgeRestartNotice('bridge');
    const pendingBridge = store.consumePendingBridgeRestartNotice();
    expect(pendingBridge?.target).toBe('bridge');
    expect(typeof pendingBridge?.requestedAtMs).toBe('number');
    expect(store.consumePendingBridgeRestartNotice()).toBeNull();

    store.setPendingBridgeRestartNotice('both');
    const pendingBoth = store.consumePendingBridgeRestartNotice();
    expect(pendingBoth?.target).toBe('both');

    store.close();
    rmSync(dbPath, { force: true });
  });
});

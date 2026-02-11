import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeService } from '../src/bridge.js';

function createBridge(): BridgeService {
  const deps = {
    sendblue: {
      getInboundMessages: vi.fn(async () => []),
      sendMessage: vi.fn(async () => ''),
      sendTypingIndicator: vi.fn(async () => undefined),
      markRead: vi.fn(async () => undefined),
    },
    store: {
      getSession: vi.fn(() => ({ threadId: null, activeTurnId: null, model: 'gpt-5.3-codex' })),
      appendAudit: vi.fn(() => undefined),
      getFlags: vi.fn(() => ({ paused: false, autoApprove: true })),
      hasProcessedMessages: vi.fn(() => false),
      markMessagesProcessed: vi.fn(() => 0),
      markMessageProcessed: vi.fn(() => true),
      setPaused: vi.fn(() => undefined),
      setAutoApprove: vi.fn(() => undefined),
      getLastTurnTimeline: vi.fn(() => []),
    },
    sessions: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      on: vi.fn(() => undefined),
      getStatus: vi.fn(() => ({
        phoneNumber: '+15550001111',
        threadId: null,
        activeTurnId: null,
        model: 'gpt-5.3-codex',
        paused: false,
        autoApprove: true,
      })),
      startOrSteerTurn: vi.fn(async () => ({ mode: 'start', threadId: 't1', turnId: 'turn1' })),
      interruptActiveTurn: vi.fn(async () => false),
      resetAndCreateNewThread: vi.fn(async () => 't1'),
      compactThread: vi.fn(async () => null),
      setModel: vi.fn(async () => undefined),
    },
    trustedPhoneNumber: '+15550001111',
    pollIntervalMs: 3000,
    modelPrefix: 'gpt-5.3-codex',
    enableTypingIndicators: true,
    enableReadReceipts: true,
    enableOutboundUnicodeFormatting: true,
    discardBacklogOnStart: true,
    inboundMediaMode: 'url_only' as const,
    typingHeartbeatMs: 10000,
  };

  return new BridgeService(deps as never);
}

describe('BridgeService poll error logging suppression', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('suppresses duplicate poll errors within the suppression window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T00:00:00.000Z'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bridge = createBridge() as unknown as { logPollLoopError: (error: unknown) => void };

    bridge.logPollLoopError(new Error('Sendblue fetch failed: 504 gateway timeout'));
    bridge.logPollLoopError(new Error('Sendblue fetch failed: 504 gateway timeout'));
    bridge.logPollLoopError(new Error('Sendblue fetch failed: 504 gateway timeout'));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(0);
  });

  it('flushes suppressed count when the same error logs again after the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-11T00:00:00.000Z'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const bridge = createBridge() as unknown as { logPollLoopError: (error: unknown) => void };

    bridge.logPollLoopError(new Error('Sendblue fetch failed: 502 bad gateway'));
    bridge.logPollLoopError(new Error('Sendblue fetch failed: 502 bad gateway'));
    vi.setSystemTime(new Date('2026-02-11T00:01:01.000Z'));
    bridge.logPollLoopError(new Error('Sendblue fetch failed: 502 bad gateway'));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });
});

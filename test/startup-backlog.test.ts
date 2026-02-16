import { describe, expect, it, vi } from 'vitest';
import { BridgeService } from '../src/bridge.js';
import type { SendblueMessage } from '../src/types.js';

function makeMessage(overrides: Partial<SendblueMessage>): SendblueMessage {
  return {
    message_handle: 'm-default',
    content: 'hello',
    from_number: '+15550001111',
    to_number: '+15550002222',
    is_outbound: false,
    ...overrides,
  };
}

function createBridgeForStartupBacklogTests(discardBacklogOnStart: boolean) {
  const deps = {
    sendblue: {
      getInboundMessages: vi.fn(async () => [] as SendblueMessage[]),
      sendMessage: vi.fn(async () => ''),
      sendTypingIndicator: vi.fn(async () => undefined),
      markRead: vi.fn(async () => undefined),
    },
    store: {
      getSession: vi.fn(() => ({ threadId: null, activeTurnId: null, model: 'gpt-5.3-codex' })),
      appendAudit: vi.fn(() => undefined),
      getFlags: vi.fn(() => ({ paused: false, autoApprove: true })),
      hasProcessedMessages: vi.fn(() => true),
      markMessagesProcessed: vi.fn(() => 0),
      markMessageProcessed: vi.fn(() => true),
      setPaused: vi.fn(() => undefined),
      setAutoApprove: vi.fn(() => undefined),
      getLastTurnTimeline: vi.fn(() => []),
      listNotifications: vi.fn(() => []),
      setPendingBridgeRestartNotice: vi.fn(() => undefined),
      consumePendingBridgeRestartNotice: vi.fn(() => null),
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
        reasoningEffort: 'medium',
        paused: false,
        autoApprove: true,
      })),
      getReasoningEffortOptions: vi.fn(() => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
      setModel: vi.fn(async (model: string) => ({ model, effort: 'medium' })),
      setModelWithEffort: vi.fn(async (model: string, effort: string) => ({ model, effort })),
      setEffortForCurrentModel: vi.fn(async (effort: string) => ({ model: 'gpt-5.3-codex', effort })),
      toggleSparkModel: vi.fn(async () => ({ enabled: true, model: 'gpt-5.3-codex-spark', effort: 'xhigh' })),
      startOrSteerTurn: vi.fn(async () => ({ mode: 'start', threadId: 't1', turnId: 'turn1' })),
      startNotificationTurn: vi.fn(async () => ({ mode: 'start', threadId: 't1', turnId: 'turnn1' })),
      interruptActiveTurn: vi.fn(async () => false),
      resetAndCreateNewThread: vi.fn(async () => 't1'),
      compactThread: vi.fn(async () => null),
      restartCodex: vi.fn(async () => ({ threadId: 'thr_restart' })),
    },
    trustedPhoneNumber: '+15550001111',
    pollIntervalMs: 3000,
    modelPrefix: 'gpt-5.3-codex',
    enableTypingIndicators: true,
    enableReadReceipts: true,
    enableOutboundUnicodeFormatting: true,
    discardBacklogOnStart,
    inboundMediaMode: 'url_only' as const,
    typingHeartbeatMs: 10000,
    notificationTurnsEnabled: true,
    notificationRawExcerptBytes: 4096,
    notificationRetentionDays: 90,
    notificationMaxRows: 25000,
  };

  return {
    bridge: new BridgeService(deps as never),
    deps,
  };
}

describe('startup backlog discard', () => {
  it('runs on every startup when enabled, even with existing processed messages', async () => {
    const { bridge, deps } = createBridgeForStartupBacklogTests(true);
    deps.sendblue.getInboundMessages.mockResolvedValueOnce([
      makeMessage({ message_handle: 'm-1', from_number: '+1 (555) 000-1111' }),
      makeMessage({ message_handle: 'm-2', from_number: '15550001111' }),
      makeMessage({ message_handle: 'm-3', from_number: '+15550009999' }),
      makeMessage({ message_handle: '' }),
    ]);
    deps.store.markMessagesProcessed.mockReturnValueOnce(2);

    const invoke = bridge as unknown as {
      bootstrapInboundBacklogIfNeeded: () => Promise<void>;
    };
    await invoke.bootstrapInboundBacklogIfNeeded();

    expect(deps.sendblue.getInboundMessages).toHaveBeenCalledWith(100);
    expect(deps.store.markMessagesProcessed).toHaveBeenCalledWith(['m-1', 'm-2']);
    expect(deps.store.hasProcessedMessages).not.toHaveBeenCalled();
    expect(deps.store.appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'system',
        summary: 'startup backlog discarded: 2 message(s)',
      }),
    );
  });

  it('skips startup backlog discard when disabled', async () => {
    const { bridge, deps } = createBridgeForStartupBacklogTests(false);

    const invoke = bridge as unknown as {
      bootstrapInboundBacklogIfNeeded: () => Promise<void>;
    };
    await invoke.bootstrapInboundBacklogIfNeeded();

    expect(deps.sendblue.getInboundMessages).not.toHaveBeenCalled();
    expect(deps.store.markMessagesProcessed).not.toHaveBeenCalled();
    expect(deps.store.appendAudit).not.toHaveBeenCalled();
  });
});

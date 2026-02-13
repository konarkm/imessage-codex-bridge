import { describe, expect, it, vi } from 'vitest';
import { BridgeService } from '../src/bridge.js';

function createBridgeForModelEffortTests() {
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
    discardBacklogOnStart: true,
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

describe('model/effort/spark command behavior', () => {
  it('parses effort suffix in /model command', async () => {
    const { bridge, deps } = createBridgeForModelEffortTests();
    const invoke = bridge as unknown as {
      executeCommand: (name: string, args: string[]) => Promise<string>;
    };

    const response = await invoke.executeCommand('model', ['gpt-5.3-codex-spark-low']);

    expect(deps.sessions.setModelWithEffort).toHaveBeenCalledWith('gpt-5.3-codex-spark', 'low');
    expect(response).toContain('Model set: gpt-5.3-codex-spark');
    expect(response).toContain('Effort: low');
  });

  it('sets effort for current model', async () => {
    const { bridge, deps } = createBridgeForModelEffortTests();
    const invoke = bridge as unknown as {
      executeCommand: (name: string, args: string[]) => Promise<string>;
    };

    const response = await invoke.executeCommand('effort', ['high']);

    expect(deps.sessions.setEffortForCurrentModel).toHaveBeenCalledWith('high');
    expect(response).toContain('Effort: high');
  });

  it('toggles spark model', async () => {
    const { bridge, deps } = createBridgeForModelEffortTests();
    const invoke = bridge as unknown as {
      executeCommand: (name: string, args: string[]) => Promise<string>;
    };

    const response = await invoke.executeCommand('spark', []);

    expect(deps.sessions.toggleSparkModel).toHaveBeenCalledTimes(1);
    expect(response).toContain('Spark enabled.');
    expect(response).toContain('gpt-5.3-codex-spark');
  });
});

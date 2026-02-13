import { describe, expect, it, vi } from 'vitest';
import { BridgeService } from '../src/bridge.js';

function createBridgeForRestartTests(): {
  bridge: BridgeService;
  deps: {
    sessions: {
      restartCodex: ReturnType<typeof vi.fn>;
    };
  };
} {
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
      startNotificationTurn: vi.fn(async () => ({ mode: 'start', threadId: 't1', turnId: 'turnn1' })),
      interruptActiveTurn: vi.fn(async () => false),
      resetAndCreateNewThread: vi.fn(async () => 't1'),
      compactThread: vi.fn(async () => null),
      setModel: vi.fn(async () => undefined),
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
    deps: {
      sessions: {
        restartCodex: deps.sessions.restartCodex,
      },
    },
  };
}

describe('/restart command behavior', () => {
  it('restarts codex only', async () => {
    const { bridge, deps } = createBridgeForRestartTests();
    const invoke = bridge as unknown as {
      executeCommand: (name: string, args: string[]) => Promise<string>;
    };

    const response = await invoke.executeCommand('restart', ['codex']);

    expect(deps.sessions.restartCodex).toHaveBeenCalledTimes(1);
    expect(response).toContain('Codex restarted.');
    expect(bridge.consumeRestartRequested()).toBe(false);
  });

  it('marks bridge restart requested for bridge target', async () => {
    const { bridge } = createBridgeForRestartTests();
    const invoke = bridge as unknown as {
      executeCommand: (name: string, args: string[]) => Promise<string>;
    };

    const response = await invoke.executeCommand('restart', ['bridge']);

    expect(response).toContain('Restarting bridge now...');
    expect(bridge.consumeRestartRequested()).toBe(true);
    expect(bridge.consumeRestartRequested()).toBe(false);
  });

  it('maps both target to bridge restart', async () => {
    const { bridge } = createBridgeForRestartTests();
    const invoke = bridge as unknown as {
      executeCommand: (name: string, args: string[]) => Promise<string>;
    };

    await invoke.executeCommand('restart', ['both']);
    expect(bridge.consumeRestartRequested()).toBe(true);
  });

  it('shows usage for invalid args', async () => {
    const { bridge } = createBridgeForRestartTests();
    const invoke = bridge as unknown as {
      executeCommand: (name: string, args: string[]) => Promise<string>;
    };

    expect(await invoke.executeCommand('restart', [])).toBe('Usage: /restart <codex|bridge|both>');
    expect(await invoke.executeCommand('restart', ['nope'])).toBe('Usage: /restart <codex|bridge|both>');
  });
});

import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexSessionManager } from '../src/codex/sessionManager.js';
import { StateStore } from '../src/state/store.js';

interface QueuedRpcResponse {
  method: string;
  result?: unknown;
  error?: Error;
}

class FakeRpcClient extends EventEmitter {
  readonly request = vi.fn(async (method: string, _params: unknown) => {
    const next = this.queue.shift();
    if (!next) {
      throw new Error(`No queued RPC response for ${method}`);
    }
    if (next.method !== method) {
      throw new Error(`Expected RPC method ${next.method}, got ${method}`);
    }
    if (next.error) {
      throw next.error;
    }
    return next.result;
  });

  readonly start = vi.fn(async () => undefined);
  readonly stop = vi.fn(async () => undefined);
  readonly respond = vi.fn(async () => undefined);
  readonly respondError = vi.fn(async () => undefined);

  private readonly queue: QueuedRpcResponse[] = [];

  enqueue(response: QueuedRpcResponse): void {
    this.queue.push(response);
  }
}

function newDbPath(): string {
  return join(tmpdir(), `imessage-codex-bridge-session-fallback-${Date.now()}-${Math.random()}.db`);
}

describe('CodexSessionManager spark fallback', () => {
  it('falls back to gpt-5.3-codex when spark is unavailable on turn/start', async () => {
    const dbPath = newDbPath();
    const store = new StateStore(dbPath, 'gpt-5.3-codex');
    const rpc = new FakeRpcClient();
    const manager = new CodexSessionManager({
      rpc: rpc as never,
      store,
      trustedPhoneNumber: '+15550001111',
      defaultModel: 'gpt-5.3-codex',
      modelPrefix: 'gpt-5.3-codex',
      cwd: '/tmp',
    });

    await manager.setModel('gpt-5.3-codex-spark');

    rpc.enqueue({
      method: 'thread/start',
      error: new Error('RPC error -32000: model gpt-5.3-codex-spark is not available for this account'),
    });
    rpc.enqueue({
      method: 'thread/start',
      result: { thread: { id: 'thread_1' } },
    });
    rpc.enqueue({
      method: 'turn/start',
      result: { turn: { id: 'turn_1' } },
    });

    const modelFallbackSpy = vi.fn();
    manager.on('modelFallback', modelFallbackSpy);

    const result = await manager.startOrSteerTurn('hello', { paused: false, autoApprove: true });

    expect(result.mode).toBe('start');
    expect(result.threadId).toBe('thread_1');
    expect(store.getSession('+15550001111').model).toBe('gpt-5.3-codex');
    expect(modelFallbackSpy).toHaveBeenCalledTimes(1);
    expect(modelFallbackSpy.mock.calls[0]?.[0]).toMatchObject({
      fromModel: 'gpt-5.3-codex-spark',
      toModel: 'gpt-5.3-codex',
      toEffort: 'medium',
    });

    const callModels = rpc.request.mock.calls
      .filter(([method]) => method === 'thread/start' || method === 'turn/start')
      .map(([, params]) => (params as { model?: string }).model ?? null);
    expect(callModels).toEqual(['gpt-5.3-codex-spark', 'gpt-5.3-codex', 'gpt-5.3-codex']);

    const turnStartCall = rpc.request.mock.calls.find(([method]) => method === 'turn/start');
    expect((turnStartCall?.[1] as { effort?: string } | undefined)?.effort).toBe('medium');

    store.close();
    rmSync(dbPath, { force: true });
  });

  it('toggles spark and restores prior model+effort', async () => {
    const dbPath = newDbPath();
    const store = new StateStore(dbPath, 'gpt-5.3-codex');
    const rpc = new FakeRpcClient();
    const manager = new CodexSessionManager({
      rpc: rpc as never,
      store,
      trustedPhoneNumber: '+15550001111',
      defaultModel: 'gpt-5.3-codex',
      modelPrefix: 'gpt-5.3-codex',
      cwd: '/tmp',
    });

    await manager.setModelWithEffort('gpt-5.3-codex', 'low');
    const enabled = await manager.toggleSparkModel();
    expect(enabled.enabled).toBe(true);
    expect(enabled.model).toBe('gpt-5.3-codex-spark');
    expect(enabled.effort).toBe('xhigh');

    await manager.setEffortForCurrentModel('high');

    const disabled = await manager.toggleSparkModel();
    expect(disabled.enabled).toBe(false);
    expect(disabled.model).toBe('gpt-5.3-codex');
    expect(disabled.effort).toBe('low');

    const status = manager.getStatus();
    expect(status.model).toBe('gpt-5.3-codex');
    expect(status.reasoningEffort).toBe('low');

    store.close();
    rmSync(dbPath, { force: true });
  });
});

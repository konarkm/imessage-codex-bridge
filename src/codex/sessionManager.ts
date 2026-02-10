import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { logWarn } from '../logger.js';
import { StateStore } from '../state/store.js';
import type { BridgeFlags, JsonRpcId } from '../types.js';
import { CodexRpcClient, type RpcNotificationEvent, type RpcServerRequestEvent } from './rpcClient.js';

const turnStartedSchema = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string() }),
});

const turnCompletedSchema = z.object({
  threadId: z.string(),
  turn: z.object({ id: z.string(), status: z.string(), error: z.any().nullable().optional() }),
});

const agentDeltaSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  delta: z.string(),
});

const itemCompletedSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    type: z.string(),
    id: z.string(),
    text: z.string().optional(),
  }),
});

const threadStartedSchema = z.object({
  thread: z.object({ id: z.string() }),
});

const turnStartResponseSchema = z.object({
  turn: z.object({ id: z.string() }),
});

const steerResponseSchema = z.object({
  turnId: z.string(),
});

const threadStartResponseSchema = z.object({
  thread: z.object({ id: z.string() }),
});

interface SessionManagerOptions {
  rpc: CodexRpcClient;
  store: StateStore;
  trustedPhoneNumber: string;
  defaultModel: string;
  modelPrefix: string;
  cwd: string;
}

export interface TurnStartResult {
  mode: 'start' | 'steer';
  turnId: string;
  threadId: string;
}

export interface SessionStatus {
  phoneNumber: string;
  threadId: string | null;
  activeTurnId: string | null;
  model: string;
  paused: boolean;
  autoApprove: boolean;
}

export class CodexSessionManager extends EventEmitter {
  private readonly rpc: CodexRpcClient;
  private readonly store: StateStore;
  private readonly trustedPhoneNumber: string;
  private readonly defaultModel: string;
  private readonly modelPrefix: string;
  private readonly cwd: string;
  private supportsTurnSteer = true;

  constructor(opts: SessionManagerOptions) {
    super();
    this.rpc = opts.rpc;
    this.store = opts.store;
    this.trustedPhoneNumber = opts.trustedPhoneNumber;
    this.defaultModel = opts.defaultModel;
    this.modelPrefix = opts.modelPrefix;
    this.cwd = opts.cwd;
  }

  async start(): Promise<void> {
    this.rpc.on('notification', (event: RpcNotificationEvent) => {
      void this.handleNotification(event);
    });

    this.rpc.on('request', (event: RpcServerRequestEvent) => {
      void this.handleServerRequest(event);
    });

    await this.rpc.start();
  }

  async stop(): Promise<void> {
    await this.rpc.stop();
  }

  async ensureThread(flags?: BridgeFlags): Promise<string> {
    const session = this.store.getSession(this.trustedPhoneNumber);
    if (session.threadId) {
      return session.threadId;
    }

    const approvalPolicy = flags?.autoApprove === false ? 'on-request' : 'never';
    const raw = await this.rpc.request<unknown>('thread/start', {
      model: session.model || this.defaultModel,
      cwd: this.cwd,
      approvalPolicy,
      sandbox: 'danger-full-access',
      experimentalRawEvents: false,
    });

    const parsed = threadStartResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid thread/start response: ${parsed.error.message}`);
    }

    const threadId = parsed.data.thread.id;
    this.store.setThreadId(this.trustedPhoneNumber, threadId);
    this.store.appendAudit({
      phoneNumber: this.trustedPhoneNumber,
      threadId,
      kind: 'system',
      summary: 'thread started',
      payload: parsed.data,
    });

    return threadId;
  }

  async startOrSteerTurn(text: string, flags: BridgeFlags): Promise<TurnStartResult> {
    const session = this.store.getSession(this.trustedPhoneNumber);
    let threadId = session.threadId ?? (await this.ensureThread(flags));

    if (session.activeTurnId && !this.supportsTurnSteer) {
      throw new Error(
        'Active turn exists but codex app-server does not support turn/steer. Use a newer codex binary (main or 0.99+).',
      );
    }

    if (session.activeTurnId && this.supportsTurnSteer) {
      try {
        const steerRaw = await this.rpc.request<unknown>('turn/steer', {
          threadId,
          expectedTurnId: session.activeTurnId,
          input: [asTextInput(text)],
        });

        const steerParsed = steerResponseSchema.safeParse(steerRaw);
        if (!steerParsed.success) {
          throw new Error(`Invalid turn/steer response: ${steerParsed.error.message}`);
        }

        this.store.appendAudit({
          phoneNumber: this.trustedPhoneNumber,
          threadId,
          turnId: steerParsed.data.turnId,
          kind: 'turn_steered',
          summary: 'turn steered',
          payload: { input: text },
        });

        return {
          mode: 'steer',
          turnId: steerParsed.data.turnId,
          threadId,
        };
      } catch (error) {
        if (isUnsupportedTurnSteer(error)) {
          this.supportsTurnSteer = false;
          this.store.appendAudit({
            phoneNumber: this.trustedPhoneNumber,
            threadId,
            kind: 'system',
            summary: 'turn/steer unsupported by codex version',
            payload: String(error),
          });
          throw new Error(
            'Codex app-server does not support turn/steer. Upgrade to a newer codex binary (main or 0.99+).',
          );
        }

        if (isThreadNotFound(error)) {
          this.store.resetRuntime(this.trustedPhoneNumber);
          threadId = await this.ensureThread(flags);
        } else {
          this.store.clearActiveTurn(this.trustedPhoneNumber);
          this.store.appendAudit({
            phoneNumber: this.trustedPhoneNumber,
            threadId,
            kind: 'error',
            summary: 'turn steer failed; falling back to turn/start',
            payload: String(error),
          });
        }
      }
    }

    let startRaw: unknown;
    try {
      startRaw = await this.rpc.request<unknown>('turn/start', {
        threadId,
        input: [asTextInput(text)],
        model: session.model,
        approvalPolicy: flags.autoApprove ? 'never' : 'on-request',
        sandboxPolicy: { type: 'dangerFullAccess' },
        cwd: this.cwd,
      });
    } catch (error) {
      if (!isThreadNotFound(error)) {
        throw error;
      }

      this.store.appendAudit({
        phoneNumber: this.trustedPhoneNumber,
        threadId,
        kind: 'error',
        summary: 'thread not found on turn/start; recreating thread',
        payload: String(error),
      });
      this.store.resetRuntime(this.trustedPhoneNumber);
      threadId = await this.ensureThread(flags);
      startRaw = await this.rpc.request<unknown>('turn/start', {
        threadId,
        input: [asTextInput(text)],
        model: session.model,
        approvalPolicy: flags.autoApprove ? 'never' : 'on-request',
        sandboxPolicy: { type: 'dangerFullAccess' },
        cwd: this.cwd,
      });
    }

    const startParsed = turnStartResponseSchema.safeParse(startRaw);
    if (!startParsed.success) {
      throw new Error(`Invalid turn/start response: ${startParsed.error.message}`);
    }

    const turnId = startParsed.data.turn.id;
    this.store.setActiveTurn(this.trustedPhoneNumber, turnId);
    this.store.appendAudit({
      phoneNumber: this.trustedPhoneNumber,
      threadId,
      turnId,
      kind: 'turn_started',
      summary: 'turn started',
      payload: { input: text },
    });

    return {
      mode: 'start',
      turnId,
      threadId,
    };
  }

  async interruptActiveTurn(): Promise<boolean> {
    const session = this.store.getSession(this.trustedPhoneNumber);
    if (!session.threadId || !session.activeTurnId) {
      return false;
    }

    await this.rpc.request('turn/interrupt', {
      threadId: session.threadId,
      turnId: session.activeTurnId,
    });

    this.store.appendAudit({
      phoneNumber: this.trustedPhoneNumber,
      threadId: session.threadId,
      turnId: session.activeTurnId,
      kind: 'turn_interrupted',
      summary: 'turn interrupt requested',
    });

    return true;
  }

  async resetAndCreateNewThread(flags: BridgeFlags): Promise<string> {
    this.store.resetRuntime(this.trustedPhoneNumber);
    return this.ensureThread(flags);
  }

  async compactThread(): Promise<string | null> {
    const session = this.store.getSession(this.trustedPhoneNumber);
    if (!session.threadId) {
      return null;
    }

    await this.rpc.request('thread/compact/start', { threadId: session.threadId });
    this.store.appendAudit({
      phoneNumber: this.trustedPhoneNumber,
      threadId: session.threadId,
      kind: 'system',
      summary: 'thread compact requested',
    });

    return session.threadId;
  }

  async setModel(model: string): Promise<void> {
    if (!model.startsWith(this.modelPrefix)) {
      throw new Error(`Model must start with ${this.modelPrefix}`);
    }

    this.store.setModel(this.trustedPhoneNumber, model);
    this.store.appendAudit({
      phoneNumber: this.trustedPhoneNumber,
      kind: 'system',
      summary: 'model updated',
      payload: { model },
    });
  }

  getStatus(): SessionStatus {
    const session = this.store.getSession(this.trustedPhoneNumber);
    const flags = this.store.getFlags();
    return {
      phoneNumber: this.trustedPhoneNumber,
      threadId: session.threadId,
      activeTurnId: session.activeTurnId,
      model: session.model,
      paused: flags.paused,
      autoApprove: flags.autoApprove,
    };
  }

  private async handleNotification(event: RpcNotificationEvent): Promise<void> {
    switch (event.method) {
      case 'thread/started': {
        const parsed = threadStartedSchema.safeParse(event.params);
        if (!parsed.success) {
          return;
        }
        this.store.setThreadId(this.trustedPhoneNumber, parsed.data.thread.id);
        return;
      }
      case 'turn/started': {
        const parsed = turnStartedSchema.safeParse(event.params);
        if (!parsed.success) {
          return;
        }

        this.store.setThreadId(this.trustedPhoneNumber, parsed.data.threadId);
        this.store.setActiveTurn(this.trustedPhoneNumber, parsed.data.turn.id);
        this.store.appendAudit({
          phoneNumber: this.trustedPhoneNumber,
          threadId: parsed.data.threadId,
          turnId: parsed.data.turn.id,
          kind: 'turn_started',
          summary: 'turn started (notification)',
          payload: event.params,
        });

        return;
      }
      case 'turn/completed': {
        const parsed = turnCompletedSchema.safeParse(event.params);
        if (!parsed.success) {
          return;
        }

        this.store.clearActiveTurn(this.trustedPhoneNumber);
        this.store.appendAudit({
          phoneNumber: this.trustedPhoneNumber,
          threadId: parsed.data.threadId,
          turnId: parsed.data.turn.id,
          kind: 'turn_completed',
          summary: `turn completed: ${parsed.data.turn.status}`,
          payload: event.params,
        });

        this.emit('turnCompleted', {
          threadId: parsed.data.threadId,
          turnId: parsed.data.turn.id,
          status: parsed.data.turn.status,
          error: parsed.data.turn.error,
        });

        return;
      }
      case 'item/agentMessage/delta': {
        const parsed = agentDeltaSchema.safeParse(event.params);
        if (!parsed.success) {
          return;
        }

        this.store.appendAudit({
          phoneNumber: this.trustedPhoneNumber,
          threadId: parsed.data.threadId,
          turnId: parsed.data.turnId,
          kind: 'agent_delta',
          summary: `delta +${parsed.data.delta.length}`,
          payload: {
            itemId: parsed.data.itemId,
          },
        });

        this.emit('assistantDelta', parsed.data);
        return;
      }
      case 'item/completed': {
        const parsed = itemCompletedSchema.safeParse(event.params);
        if (!parsed.success) {
          return;
        }

        if (parsed.data.item.type === 'agentMessage') {
          this.emit('assistantFinal', {
            threadId: parsed.data.threadId,
            turnId: parsed.data.turnId,
            itemId: parsed.data.item.id,
            text: parsed.data.item.text ?? '',
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private async handleServerRequest(event: RpcServerRequestEvent): Promise<void> {
    if (event.method !== 'item/commandExecution/requestApproval' && event.method !== 'item/fileChange/requestApproval') {
      await this.rpc.respondError(event.id, -32601, `Unsupported method: ${event.method}`);
      return;
    }

    const flags = this.store.getFlags();
    const decision = flags.autoApprove && !flags.paused ? 'accept' : 'decline';

    this.store.appendAudit({
      phoneNumber: this.trustedPhoneNumber,
      kind: 'approval_request',
      summary: `${event.method} -> ${decision}`,
      payload: event.params,
    });

    await this.rpc.respond(event.id as JsonRpcId, { decision });
    this.store.appendAudit({
      phoneNumber: this.trustedPhoneNumber,
      kind: 'approval_response',
      summary: `${event.method} responded`,
      payload: { decision },
    });

    if (!flags.autoApprove || flags.paused) {
      this.emit('approvalDeclinedDueToPolicy', {
        method: event.method,
      });
    }
  }
}

function asTextInput(text: string): { type: 'text'; text: string; text_elements: [] } {
  return {
    type: 'text',
    text,
    text_elements: [],
  };
}

function isThreadNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') {
    return false;
  }
  return message.toLowerCase().includes('thread not found');
}

function isUnsupportedTurnSteer(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') {
    return false;
  }
  const lower = message.toLowerCase();
  return lower.includes('unknown variant `turn/steer`') || lower.includes('unknown method') && lower.includes('turn/steer');
}

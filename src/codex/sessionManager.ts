import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { NotificationRecord, NotificationSource, NotificationStatus } from '../notifications/types.js';
import { logWarn } from '../logger.js';
import { StateStore } from '../state/store.js';
import type { BridgeFlags, JsonRpcId } from '../types.js';
import { nowMs } from '../utils.js';
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

const itemStartedSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  item: z.object({
    type: z.string(),
    id: z.string().optional(),
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

const threadResumeResponseSchema = z.object({
  thread: z.object({ id: z.string() }),
});

const dynamicToolCallSchema = z.object({
  threadId: z.string(),
  turnId: z.string(),
  callId: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

const notificationListArgsSchema = z.object({
  count: z.number().int().min(1).max(200).optional(),
  source: z.enum(['all', 'webhook', 'cron', 'heartbeat']).optional(),
});

const notificationGetArgsSchema = z.object({
  id: z.string().min(1),
});

const notificationSearchArgsSchema = z.object({
  source: z.enum(['all', 'webhook', 'cron', 'heartbeat']).optional(),
  status: z.enum(['received', 'queued', 'processing', 'sent', 'suppressed', 'failed', 'duplicate']).optional(),
  sinceHours: z.number().int().min(1).max(24 * 365).optional(),
  limit: z.number().int().min(1).max(200).optional(),
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
  private attachedThreadId: string | null = null;

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
    this.attachedThreadId = null;
  }

  async stop(): Promise<void> {
    await this.rpc.stop();
  }

  async ensureThread(flags?: BridgeFlags): Promise<string> {
    const session = this.store.getSession(this.trustedPhoneNumber);
    if (session.threadId) {
      if (this.attachedThreadId === session.threadId) {
        return session.threadId;
      }

      try {
        const resumeRaw = await this.rpc.request<unknown>('thread/resume', {
          threadId: session.threadId,
        });
        const resumeParsed = threadResumeResponseSchema.safeParse(resumeRaw);
        if (!resumeParsed.success) {
          throw new Error(`Invalid thread/resume response: ${resumeParsed.error.message}`);
        }

        const resumedThreadId = resumeParsed.data.thread.id;
        this.store.setThreadId(this.trustedPhoneNumber, resumedThreadId);
        this.attachedThreadId = resumedThreadId;
        this.store.appendAudit({
          phoneNumber: this.trustedPhoneNumber,
          threadId: resumedThreadId,
          kind: 'system',
          summary: 'thread resumed',
          payload: resumeParsed.data,
        });
        return resumedThreadId;
      } catch (error) {
        if (!isThreadNotFound(error)) {
          throw error;
        }

        this.store.appendAudit({
          phoneNumber: this.trustedPhoneNumber,
          threadId: session.threadId,
          kind: 'error',
          summary: 'thread not found on thread/resume; recreating thread',
          payload: String(error),
        });

        this.store.resetRuntime(this.trustedPhoneNumber);
        this.attachedThreadId = null;
      }
    }

    const approvalPolicy = flags?.autoApprove === false ? 'on-request' : 'never';
    const threadStartParams = {
      model: session.model || this.defaultModel,
      cwd: this.cwd,
      approvalPolicy,
      sandbox: 'danger-full-access' as const,
      experimentalRawEvents: false,
      dynamicTools: notificationDynamicTools,
    };

    let raw: unknown;
    try {
      raw = await this.rpc.request<unknown>('thread/start', threadStartParams);
    } catch (error) {
      if (!isThreadStartTimeout(error)) {
        throw error;
      }

      // The app-server can occasionally wedge and stop responding to thread/start.
      // Restart once and retry before surfacing an error to the user.
      this.store.appendAudit({
        phoneNumber: this.trustedPhoneNumber,
        kind: 'error',
        summary: 'thread/start timed out; restarting codex app-server and retrying',
        payload: String(error),
      });

      await this.rpc.stop();
      await this.rpc.start();
      this.attachedThreadId = null;
      raw = await this.rpc.request<unknown>('thread/start', threadStartParams);
    }

    const parsed = threadStartResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid thread/start response: ${parsed.error.message}`);
    }

    const threadId = parsed.data.thread.id;
    this.store.setThreadId(this.trustedPhoneNumber, threadId);
    this.attachedThreadId = threadId;
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
    let session = this.store.getSession(this.trustedPhoneNumber);
    let threadId = await this.ensureThread(flags);
    session = this.store.getSession(this.trustedPhoneNumber);

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
          this.attachedThreadId = null;
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
        summary: 'thread not found on turn/start; attempting resume',
        payload: String(error),
      });

      this.attachedThreadId = null;
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

  async startNotificationTurn(args: {
    text: string;
    flags: BridgeFlags;
    outputSchema: unknown;
  }): Promise<TurnStartResult> {
    const session = this.store.getSession(this.trustedPhoneNumber);
    let threadId = await this.ensureThread(args.flags);

    let startRaw: unknown;
    try {
      startRaw = await this.rpc.request<unknown>('turn/start', {
        threadId,
        input: [asTextInput(args.text)],
        model: session.model,
        approvalPolicy: args.flags.autoApprove ? 'never' : 'on-request',
        sandboxPolicy: { type: 'dangerFullAccess' },
        cwd: this.cwd,
        outputSchema: args.outputSchema,
      });
    } catch (error) {
      if (!isThreadNotFound(error)) {
        throw error;
      }

      this.store.appendAudit({
        phoneNumber: this.trustedPhoneNumber,
        threadId,
        kind: 'error',
        summary: 'thread not found on notification turn/start; attempting resume',
        payload: String(error),
      });

      this.attachedThreadId = null;
      threadId = await this.ensureThread(args.flags);
      startRaw = await this.rpc.request<unknown>('turn/start', {
        threadId,
        input: [asTextInput(args.text)],
        model: session.model,
        approvalPolicy: args.flags.autoApprove ? 'never' : 'on-request',
        sandboxPolicy: { type: 'dangerFullAccess' },
        cwd: this.cwd,
        outputSchema: args.outputSchema,
      });
    }

    const startParsed = turnStartResponseSchema.safeParse(startRaw);
    if (!startParsed.success) {
      throw new Error(`Invalid notification turn/start response: ${startParsed.error.message}`);
    }

    const turnId = startParsed.data.turn.id;
    this.store.setActiveTurn(this.trustedPhoneNumber, turnId);
    this.store.appendAudit({
      phoneNumber: this.trustedPhoneNumber,
      threadId,
      turnId,
      kind: 'turn_started',
      summary: 'notification turn started',
      payload: { input: args.text },
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
    this.attachedThreadId = null;
    return this.ensureThread(flags);
  }

  async compactThread(): Promise<string | null> {
    const session = this.store.getSession(this.trustedPhoneNumber);
    if (!session.threadId) {
      return null;
    }

    let threadId = session.threadId;
    try {
      await this.rpc.request('thread/compact/start', { threadId });
    } catch (error) {
      if (!isThreadNotFound(error)) {
        throw error;
      }

      this.store.appendAudit({
        phoneNumber: this.trustedPhoneNumber,
        threadId,
        kind: 'error',
        summary: 'thread not found on thread/compact/start; recreating thread',
        payload: String(error),
      });

      this.attachedThreadId = null;
      threadId = await this.ensureThread(this.store.getFlags());
      await this.rpc.request('thread/compact/start', { threadId });
    }

    this.store.appendAudit({
      phoneNumber: this.trustedPhoneNumber,
      threadId,
      kind: 'system',
      summary: 'thread compact requested',
    });

    return threadId;
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
        this.attachedThreadId = parsed.data.thread.id;
        this.store.setThreadId(this.trustedPhoneNumber, parsed.data.thread.id);
        return;
      }
      case 'turn/started': {
        const parsed = turnStartedSchema.safeParse(event.params);
        if (!parsed.success) {
          return;
        }

        if (!this.isPrimaryThreadEvent(parsed.data.threadId)) {
          return;
        }

        this.attachedThreadId = parsed.data.threadId;
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

        if (!this.isPrimaryThreadEvent(parsed.data.threadId)) {
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

        if (!this.isPrimaryThreadEvent(parsed.data.threadId)) {
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
      case 'item/started': {
        const parsed = itemStartedSchema.safeParse(event.params);
        if (!parsed.success) {
          return;
        }

        if (!this.isPrimaryThreadEvent(parsed.data.threadId)) {
          return;
        }

        if (parsed.data.item.type === 'contextCompaction') {
          this.store.appendAudit({
            phoneNumber: this.trustedPhoneNumber,
            threadId: parsed.data.threadId,
            turnId: parsed.data.turnId,
            kind: 'system',
            summary: 'context compaction started',
            payload: event.params,
          });

          this.emit('compactionStarted', {
            threadId: parsed.data.threadId,
            turnId: parsed.data.turnId,
            itemId: parsed.data.item.id ?? null,
          });
        }

        return;
      }
      case 'item/completed': {
        const parsed = itemCompletedSchema.safeParse(event.params);
        if (!parsed.success) {
          return;
        }

        if (!this.isPrimaryThreadEvent(parsed.data.threadId)) {
          return;
        }

        if (parsed.data.item.type === 'contextCompaction') {
          this.store.appendAudit({
            phoneNumber: this.trustedPhoneNumber,
            threadId: parsed.data.threadId,
            turnId: parsed.data.turnId,
            kind: 'system',
            summary: 'context compaction completed',
            payload: event.params,
          });

          this.emit('compactionCompleted', {
            threadId: parsed.data.threadId,
            turnId: parsed.data.turnId,
            itemId: parsed.data.item.id,
          });
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

  private isPrimaryThreadEvent(threadId: string): boolean {
    const session = this.store.getSession(this.trustedPhoneNumber);
    return session.threadId === null || session.threadId === threadId;
  }

  private async handleServerRequest(event: RpcServerRequestEvent): Promise<void> {
    if (event.method === 'item/tool/call') {
      await this.handleDynamicToolCall(event);
      return;
    }

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

  private async handleDynamicToolCall(event: RpcServerRequestEvent): Promise<void> {
    const parsed = dynamicToolCallSchema.safeParse(event.params);
    if (!parsed.success) {
      await this.rpc.respondError(event.id, -32602, `Invalid item/tool/call params: ${parsed.error.message}`);
      return;
    }

    try {
      let payload: unknown;
      switch (parsed.data.tool) {
        case 'notifications_list': {
          const args = notificationListArgsSchema.parse(parsed.data.arguments);
          const notifications = this.store.listNotifications({
            count: args.count ?? 20,
            source: (args.source as NotificationSource | undefined) ?? 'all',
          });
          payload = {
            notifications: notifications.map((row) => compactNotification(row)),
          };
          break;
        }
        case 'notifications_get': {
          const args = notificationGetArgsSchema.parse(parsed.data.arguments);
          const notification = this.store.getNotificationById(args.id);
          payload = {
            notification: notification ? fullNotification(notification) : null,
          };
          break;
        }
        case 'notifications_search': {
          const args = notificationSearchArgsSchema.parse(parsed.data.arguments);
          const sinceMs = args.sinceHours ? nowMs() - args.sinceHours * 60 * 60 * 1000 : undefined;
          const notifications = this.store.queryNotifications({
            source: (args.source as NotificationSource | undefined) ?? 'all',
            status: args.status as NotificationStatus | undefined,
            sinceMs,
            limit: args.limit ?? 20,
          });
          payload = {
            notifications: notifications.map((row) => compactNotification(row)),
          };
          break;
        }
        default:
          throw new Error(`Unknown dynamic tool: ${parsed.data.tool}`);
      }

      await this.rpc.respond(event.id, {
        success: true,
        contentItems: [{ type: 'inputText', text: JSON.stringify(payload, null, 2) }],
      });
    } catch (error) {
      await this.rpc.respond(event.id, {
        success: false,
        contentItems: [{ type: 'inputText', text: `tool call failed: ${getErrorMessage(error)}` }],
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

function isThreadStartTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') {
    return false;
  }
  return message.includes('RPC request timed out: thread/start');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function compactNotification(row: NotificationRecord): Record<string, unknown> {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    receivedAt: new Date(row.receivedAtMs).toISOString(),
    summary: row.summary,
    duplicateCount: row.duplicateCount,
    delivery: row.delivery,
    reasonCode: row.reasonCode,
    message: row.messageExcerpt,
    error: row.errorText,
  };
}

function fullNotification(row: NotificationRecord): Record<string, unknown> {
  return {
    ...compactNotification(row),
    sourceAccount: row.sourceAccount,
    sourceEventId: row.sourceEventId,
    dedupeKey: row.dedupeKey,
    payloadHash: row.payloadHash,
    rawExcerpt: row.rawExcerpt,
    rawSizeBytes: row.rawSizeBytes,
    rawTruncated: row.rawTruncated,
    firstSeenAt: new Date(row.firstSeenAtMs).toISOString(),
    lastSeenAt: new Date(row.lastSeenAtMs).toISOString(),
    threadId: row.threadId,
    turnId: row.turnId,
    decision: row.decision,
  };
}

const notificationDynamicTools = [
  {
    name: 'notifications_list',
    description: 'List recent notifications from bridge-local notification history.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 200 },
        source: { type: 'string', enum: ['all', 'webhook', 'cron', 'heartbeat'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'notifications_get',
    description: 'Get one notification by id from bridge-local notification history.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'notifications_search',
    description: 'Search bridge-local notifications by source/status/time.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['all', 'webhook', 'cron', 'heartbeat'] },
        status: { type: 'string', enum: ['received', 'queued', 'processing', 'sent', 'suppressed', 'failed', 'duplicate'] },
        sinceHours: { type: 'integer', minimum: 1, maximum: 8760 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
] as const;

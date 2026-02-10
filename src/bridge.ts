import { logError, logInfo, logWarn } from './logger.js';
import { parseSlashCommand, helpText } from './router/commands.js';
import { SendblueClient } from './sendblue/client.js';
import { StateStore } from './state/store.js';
import { normalizePhone, sleep } from './utils.js';
import { CodexSessionManager } from './codex/sessionManager.js';
import type { SendblueMessage, SessionState } from './types.js';

interface BridgeDeps {
  sendblue: SendblueClient;
  store: StateStore;
  sessions: CodexSessionManager;
  trustedPhoneNumber: string;
  pollIntervalMs: number;
  modelPrefix: string;
}

class AssistantRelay {
  private readonly sentItemIds = new Set<string>();
  private readonly sentItemOrder: string[] = [];
  private readonly maxTrackedItems = 4000;

  constructor(private readonly sendText: (text: string) => Promise<void>) {}

  onDelta(_itemId: string, _turnId: string, _delta: string): void {
    // Intentionally no-op: streaming deltas are noisy over SMS/iMessage
    // and can trip anti-spam safeguards. We only send final assistant text.
  }

  onFinal(itemId: string, _turnId: string, text: string): void {
    if (this.sentItemIds.has(itemId)) {
      return;
    }

    const textToSend = text.trim();
    if (textToSend.length === 0) {
      return;
    }

    this.trackSentItem(itemId);
    void this.sendText(textToSend);
  }

  onTurnCompleted(_turnId: string): void {
    // no-op for now
  }

  private trackSentItem(itemId: string): void {
    this.sentItemIds.add(itemId);
    this.sentItemOrder.push(itemId);

    if (this.sentItemOrder.length <= this.maxTrackedItems) {
      return;
    }

    const evicted = this.sentItemOrder.shift();
    if (evicted) {
      this.sentItemIds.delete(evicted);
    }
  }
}

export class BridgeService {
  private running = false;
  private inPoll = false;
  private outboundQueue: Promise<void> = Promise.resolve();
  private readonly relay: AssistantRelay;

  constructor(private readonly deps: BridgeDeps) {
    this.relay = new AssistantRelay(async (text) => {
      await this.enqueueOutbound(text);
    });
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.deps.sessions.start();
    this.registerSessionEvents();
    logInfo('Bridge service started');

    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        logError('Poll loop error', error);
      }
      await sleep(this.deps.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.deps.sessions.stop();
  }

  private registerSessionEvents(): void {
    this.deps.sessions.on('assistantDelta', (event: { itemId: string; turnId: string; delta: string }) => {
      this.relay.onDelta(event.itemId, event.turnId, event.delta);
    });

    this.deps.sessions.on('assistantFinal', (event: { itemId: string; turnId: string; text: string }) => {
      this.relay.onFinal(event.itemId, event.turnId, event.text);
    });

    this.deps.sessions.on(
      'turnCompleted',
      (event: { turnId: string; status: string; error?: { error?: { message?: string }; message?: string } }) => {
        this.relay.onTurnCompleted(event.turnId);

        if (event.status === 'failed') {
          const message = getErrorMessage(event.error);
          void this.enqueueOutbound(`Turn failed: ${message}`);
        }

        if (event.status === 'interrupted') {
          void this.enqueueOutbound('Interrupted.');
        }
      },
    );

    this.deps.sessions.on('approvalDeclinedDueToPolicy', () => {
      void this.enqueueOutbound('Approval request declined by policy (paused or auto-approve disabled).');
    });
  }

  private async pollOnce(): Promise<void> {
    if (this.inPoll) {
      return;
    }

    this.inPoll = true;
    try {
      const messages = await this.deps.sendblue.getInboundMessages(100);
      const sorted = sortMessagesAscending(messages);

      for (const message of sorted) {
        await this.processInboundMessage(message);
      }
    } finally {
      this.inPoll = false;
    }
  }

  private async processInboundMessage(message: SendblueMessage): Promise<void> {
    const fromNumber = normalizePhone(message.from_number);
    if (fromNumber !== this.deps.trustedPhoneNumber) {
      return;
    }

    if (!message.message_handle) {
      return;
    }

    const firstSeen = this.deps.store.markMessageProcessed(message.message_handle);
    if (!firstSeen) {
      return;
    }

    const text = message.content.trim();
    this.deps.store.appendAudit({
      phoneNumber: fromNumber,
      kind: 'inbound_message',
      summary: text.slice(0, 200),
      payload: {
        messageHandle: message.message_handle,
      },
    });

    if (text.length === 0) {
      await this.enqueueOutbound('Text-only v1: media-only inbound messages are not supported yet.');
      return;
    }

    if (text.startsWith('/')) {
      const command = parseSlashCommand(text);
      if (!command) {
        await this.enqueueOutbound('Unknown command. Use /help');
        return;
      }

      const response = await this.executeCommand(command.name, command.args);
      if (response) {
        await this.enqueueOutbound(response);
      }
      return;
    }

    await this.handleUserText(text);
  }

  private async handleUserText(text: string): Promise<void> {
    const flags = this.deps.store.getFlags();
    if (flags.paused) {
      await this.enqueueOutbound('Bridge is paused. Use /resume to continue.');
      return;
    }

    try {
      const result = await this.deps.sessions.startOrSteerTurn(text, flags);
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        threadId: result.threadId,
        turnId: result.turnId,
        kind: result.mode === 'steer' ? 'turn_steered' : 'turn_started',
        summary: `${result.mode} accepted`,
      });
    } catch (error) {
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        kind: 'error',
        summary: 'failed to submit input to codex',
        payload: String(error),
      });
      await this.enqueueOutbound(`Failed to submit message: ${String(error)}`);
    }
  }

  private async executeCommand(name: string, args: string[]): Promise<string> {
    this.deps.store.appendAudit({
      phoneNumber: this.deps.trustedPhoneNumber,
      kind: 'command',
      summary: `/${name}`,
      payload: { args },
    });

    switch (name) {
      case 'help':
        return helpText();
      case 'status':
        return this.renderStatus();
      case 'stop': {
        const interrupted = await this.deps.sessions.interruptActiveTurn();
        return interrupted ? 'Interrupt requested.' : 'Nothing to interrupt.';
      }
      case 'reset': {
        const flags = this.deps.store.getFlags();
        const threadId = await this.deps.sessions.resetAndCreateNewThread(flags);
        return `Reset complete.\nThread: ${threadId}`;
      }
      case 'debug':
        return this.renderDebugTimeline();
      case 'thread': {
        if (args[0] === 'new') {
          const flags = this.deps.store.getFlags();
          const threadId = await this.deps.sessions.resetAndCreateNewThread(flags);
          return `New thread started: ${threadId}`;
        }
        const session = this.currentSession();
        return `Thread: ${session.threadId ?? '(none)'}\nActive turn: ${session.activeTurnId ?? '(none)'}`;
      }
      case 'compact': {
        const threadId = await this.deps.sessions.compactThread();
        return threadId ? `Compaction requested for thread ${threadId}` : 'No active thread to compact.';
      }
      case 'model': {
        if (args.length === 0) {
          return `Usage: /model <id>\nAllowed prefix: ${this.deps.modelPrefix}`;
        }
        const model = args.join(' ').trim();
        await this.deps.sessions.setModel(model);
        return `Model set: ${model}`;
      }
      case 'pause':
        this.deps.store.setPaused(true);
        this.deps.store.setAutoApprove(false);
        return 'Paused. New turns blocked. Auto-approve disabled.';
      case 'resume':
        this.deps.store.setPaused(false);
        this.deps.store.setAutoApprove(true);
        return 'Resumed. New turns enabled. Auto-approve enabled.';
      default:
        return 'Unknown command. Use /help';
    }
  }

  private renderStatus(): string {
    const status = this.deps.sessions.getStatus();
    return [
      'Bridge Status',
      `phone: ${status.phoneNumber}`,
      `thread: ${status.threadId ?? '(none)'}`,
      `active_turn: ${status.activeTurnId ?? '(none)'}`,
      `model: ${status.model}`,
      `paused: ${status.paused}`,
      `auto_approve: ${status.autoApprove}`,
    ].join('\n');
  }

  private renderDebugTimeline(): string {
    const events = this.deps.store.getLastTurnTimeline(this.deps.trustedPhoneNumber, 80);
    if (events.length === 0) {
      return 'No timeline available yet.';
    }

    const lines = ['Last Turn Timeline'];
    for (const event of events) {
      const time = new Date(event.tsMs).toISOString().split('T')[1]?.replace('Z', '') ?? '';
      lines.push(`${time} ${event.kind}: ${event.summary}`);
    }
    return lines.join('\n');
  }

  private currentSession(): SessionState {
    return this.deps.store.getSession(this.deps.trustedPhoneNumber);
  }

  private async enqueueOutbound(text: string): Promise<void> {
    this.outboundQueue = this.outboundQueue.then(async () => {
      const chunks = splitMessage(text, 1200);
      for (const chunk of chunks) {
        if (chunk.trim().length === 0) {
          continue;
        }

        try {
          await this.deps.sendblue.sendMessage(this.deps.trustedPhoneNumber, chunk);
          this.deps.store.appendAudit({
            phoneNumber: this.deps.trustedPhoneNumber,
            kind: 'outbound_message',
            summary: chunk.slice(0, 200),
          });
        } catch (error) {
          logError('Failed to send outbound message', error);
        }
      }
    });

    return this.outboundQueue;
  }
}

export function splitMessage(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const parts: string[] = [];
  let remaining = normalized;

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars);
    if (splitAt < Math.floor(maxChars * 0.4)) {
      splitAt = remaining.lastIndexOf(' ', maxChars);
    }
    if (splitAt < 1) {
      splitAt = maxChars;
    }

    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    parts.push(remaining);
  }

  return parts;
}

function sortMessagesAscending(messages: SendblueMessage[]): SendblueMessage[] {
  const copy = [...messages];
  copy.sort((a, b) => getMessageTs(a) - getMessageTs(b));
  return copy;
}

function getMessageTs(message: SendblueMessage): number {
  const candidate = message.created_at ?? message.date_sent ?? message.date_updated;
  if (!candidate) {
    return Number.MAX_SAFE_INTEGER;
  }
  const ts = Date.parse(candidate);
  if (Number.isNaN(ts)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return ts;
}

function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string') {
      return record.message;
    }
    if (record.error && typeof record.error === 'object') {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === 'string') {
        return nested.message;
      }
    }
  }
  return 'unknown error';
}

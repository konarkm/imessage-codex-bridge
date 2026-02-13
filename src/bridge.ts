import { logError, logInfo, logWarn } from './logger.js';
import { normalizeNotification } from './notifications/normalize.js';
import { parseNotificationDecision, notificationDecisionOutputSchema } from './notifications/schema.js';
import type { NotificationDecision, NotificationRecord, NotificationSource } from './notifications/types.js';
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
  enableTypingIndicators: boolean;
  enableReadReceipts: boolean;
  enableOutboundUnicodeFormatting: boolean;
  discardBacklogOnStart: boolean;
  inboundMediaMode: 'url_only';
  typingHeartbeatMs: number;
  notificationTurnsEnabled: boolean;
  notificationRawExcerptBytes: number;
  notificationRetentionDays: number;
  notificationMaxRows: number;
}

interface TurnContext {
  mode: 'user' | 'notification';
  notificationId?: string;
  attempt?: number;
  latestAssistantText?: string;
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
  private static readonly POLL_ERROR_SUPPRESSION_WINDOW_MS = 60_000;

  private running = false;
  private inPoll = false;
  private outboundQueue: Promise<void> = Promise.resolve();
  private readonly relay: AssistantRelay;
  private typingTurnId: string | null = null;
  private typingItemId: string | null = null;
  private lastTypingSentAtMs = 0;
  private typingSendInFlight = false;
  private typingBackoffUntilMs = 0;
  private readonly typingFailureBackoffMs = 30_000;
  private lastPollErrorSignature: string | null = null;
  private lastPollErrorAtMs = 0;
  private suppressedPollErrorCount = 0;
  private readonly turnContexts = new Map<string, TurnContext>();
  private lastNotificationPruneAtMs = 0;
  private static readonly NOTIFICATION_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
  private restartRequested = false;

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

    try {
      await this.bootstrapInboundBacklogIfNeeded();
    } catch (error) {
      logWarn('Startup backlog bootstrap failed; continuing without discard', error);
    }

    logInfo('Bridge service started');
    await this.maybeSendRestartOnlineAnnouncement();

    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        this.logPollLoopError(error);
      }
      await sleep(this.deps.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.flushSuppressedPollErrors();
    await this.deps.sessions.stop();
  }

  consumeRestartRequested(): boolean {
    const requested = this.restartRequested;
    this.restartRequested = false;
    return requested;
  }

  async ingestNotification(args: {
    payload: unknown;
    source?: NotificationSource;
    sourceAccount?: string | null;
    sourceEventId?: string | null;
  }): Promise<{ notificationId: string; duplicate: boolean }> {
    const normalized = normalizeNotification({
      payload: args.payload,
      source: args.source ?? 'webhook',
      sourceAccount: args.sourceAccount,
      sourceEventId: args.sourceEventId,
      rawExcerptBytes: this.deps.notificationRawExcerptBytes,
    });

    const result = this.deps.store.appendNotification(normalized);
    if (result.inserted) {
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        kind: 'notification_ingested',
        summary: `${normalized.source} notification ingested`,
        payload: {
          notificationId: normalized.id,
          sourceEventId: normalized.sourceEventId,
          summary: normalized.summary,
        },
      });
    } else {
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        kind: 'notification_duplicate',
        summary: `${normalized.source} notification duplicate`,
        payload: {
          dedupeKey: normalized.dedupeKey,
          duplicateOf: result.duplicateOf,
        },
      });
    }

    return {
      notificationId: result.id,
      duplicate: !result.inserted,
    };
  }

  private registerSessionEvents(): void {
    this.deps.sessions.on('assistantDelta', (event: { itemId: string; turnId: string; delta: string }) => {
      this.relay.onDelta(event.itemId, event.turnId, event.delta);
      const context = this.turnContexts.get(event.turnId);
      if (!context || context.mode === 'user') {
        void this.maybeSendTypingIndicator(event.turnId, event.itemId);
      }
    });

    this.deps.sessions.on('assistantFinal', (event: { itemId: string; turnId: string; text: string }) => {
      const context = this.turnContexts.get(event.turnId);
      if (!context || context.mode === 'user') {
        this.relay.onFinal(event.itemId, event.turnId, event.text);
        return;
      }

      context.latestAssistantText = event.text.trim();
      this.turnContexts.set(event.turnId, context);
    });

    this.deps.sessions.on(
      'turnCompleted',
      (event: { turnId: string; status: string; error?: { error?: { message?: string }; message?: string } }) => {
        void this.handleTurnCompleted(event);
      },
    );

    this.deps.sessions.on('approvalDeclinedDueToPolicy', () => {
      void this.enqueueOutbound('Approval request declined by policy (paused or auto-approve disabled).');
    });

    this.deps.sessions.on('compactionStarted', () => {
      void this.enqueueOutbound('Compaction started.');
    });

    this.deps.sessions.on('compactionCompleted', () => {
      void this.enqueueOutbound('Compaction complete.');
    });

    this.deps.sessions.on('modelFallback', (event: { fromModel: string; toModel: string }) => {
      void this.enqueueOutbound(
        `${event.fromModel} is unavailable for this account. Switched to ${event.toModel}.`,
      );
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
        if (!this.running) {
          break;
        }
      }

      if (!this.running) {
        return;
      }

      await this.maybeProcessQueuedNotification();
      this.maybePruneNotifications();
    } finally {
      this.inPoll = false;
    }
  }

  private async bootstrapInboundBacklogIfNeeded(): Promise<void> {
    if (!this.deps.discardBacklogOnStart) {
      return;
    }

    if (this.deps.store.hasProcessedMessages()) {
      return;
    }

    const messages = await this.deps.sendblue.getInboundMessages(100);
    const handles = messages
      .filter((message) => normalizePhone(message.from_number) === this.deps.trustedPhoneNumber)
      .map((message) => message.message_handle)
      .filter((handle) => handle.length > 0);

    if (handles.length === 0) {
      return;
    }

    const discarded = this.deps.store.markMessagesProcessed(handles);
    if (discarded < 1) {
      return;
    }

    this.deps.store.appendAudit({
      phoneNumber: this.deps.trustedPhoneNumber,
      kind: 'system',
      summary: `startup backlog discarded: ${discarded} message(s)`,
      payload: { sampledInbound: handles.length },
    });
    logInfo(`Discarded ${discarded} pre-existing inbound message(s) at startup`);
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
    const mediaUrl = message.media_url?.trim() ?? '';
    this.deps.store.appendAudit({
      phoneNumber: fromNumber,
      kind: 'inbound_message',
      summary: text.length > 0 ? text.slice(0, 200) : mediaUrl ? `[media] ${mediaUrl}` : '(empty)',
      payload: {
        messageHandle: message.message_handle,
        mediaUrl: mediaUrl || null,
      },
    });

    if (text.length === 0 && mediaUrl.length === 0) {
      return;
    }

    if (text.startsWith('/')) {
      const command = parseSlashCommand(text);
      if (!command) {
        await this.enqueueOutbound('Unknown command. Use /help');
        await this.maybeSendReadReceipt(fromNumber, 'slash command rejected: unknown');
        return;
      }

      try {
        const response = await this.executeCommand(command.name, command.args);
        if (response) {
          await this.enqueueOutbound(response);
        }
        await this.maybeSendReadReceipt(fromNumber, `slash command accepted: /${command.name}`);
      } catch (error) {
        this.deps.store.appendAudit({
          phoneNumber: fromNumber,
          kind: 'error',
          summary: `command failed: /${command.name}`,
          payload: String(error),
        });
        await this.enqueueOutbound(`/${command.name} failed: ${getErrorMessage(error)}`);
        await this.maybeSendReadReceipt(fromNumber, `slash command failed: /${command.name}`);
      }
      return;
    }

    const inputText = composeInboundTextForCodex(text, mediaUrl, this.deps.inboundMediaMode);
    if (inputText.length === 0) {
      return;
    }

    const accepted = await this.handleUserText(inputText);
    if (accepted) {
      await this.maybeSendReadReceipt(fromNumber, 'inbound text/media accepted');
    }
  }

  private async maybeProcessQueuedNotification(): Promise<void> {
    if (!this.deps.notificationTurnsEnabled) {
      return;
    }

    const session = this.currentSession();
    if (session.activeTurnId) {
      return;
    }

    const queued = this.deps.store.claimNextQueuedNotification();
    if (!queued) {
      return;
    }

    await this.startNotificationTurn(queued, 1);
  }

  private async startNotificationTurn(notification: NotificationRecord, attempt: number): Promise<void> {
    const flags = this.deps.store.getFlags();
    const prompt = formatNotificationPrompt(notification);
    try {
      const result = await this.deps.sessions.startNotificationTurn({
        text: prompt,
        flags,
        outputSchema: notificationDecisionOutputSchema,
      });

      this.turnContexts.set(result.turnId, {
        mode: 'notification',
        notificationId: notification.id,
        attempt,
        latestAssistantText: '',
      });
      this.deps.store.markNotificationProcessing(notification.id, result.threadId, result.turnId);
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        threadId: result.threadId,
        turnId: result.turnId,
        kind: 'notification_processing',
        summary: `notification turn started (attempt ${attempt})`,
        payload: {
          notificationId: notification.id,
          source: notification.source,
        },
      });
    } catch (error) {
      this.deps.store.recordNotificationFailure({
        id: notification.id,
        errorText: getErrorMessage(error),
      });
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        kind: 'notification_failed',
        summary: 'notification turn failed to start',
        payload: {
          notificationId: notification.id,
          attempt,
          error: getErrorMessage(error),
        },
      });
    }
  }

  private async handleTurnCompleted(event: {
    turnId: string;
    status: string;
    error?: { error?: { message?: string }; message?: string };
  }): Promise<void> {
    this.relay.onTurnCompleted(event.turnId);
    this.clearTypingStateForTurn(event.turnId);

    const context = this.turnContexts.get(event.turnId);
    this.turnContexts.delete(event.turnId);

    if (!context || context.mode === 'user') {
      if (event.status === 'failed') {
        const message = getErrorMessage(event.error);
        await this.enqueueOutbound(`Turn failed: ${message}`);
      }

      if (event.status === 'interrupted') {
        await this.enqueueOutbound('Interrupted.');
      }
      return;
    }

    await this.handleNotificationTurnCompleted(event, context);
  }

  private async handleNotificationTurnCompleted(
    event: { turnId: string; status: string; error?: { error?: { message?: string }; message?: string } },
    context: TurnContext,
  ): Promise<void> {
    const notificationId = context.notificationId;
    if (!notificationId) {
      return;
    }

    if (event.status === 'failed' || event.status === 'interrupted') {
      this.deps.store.recordNotificationFailure({
        id: notificationId,
        threadId: this.currentSession().threadId,
        turnId: event.turnId,
        errorText: `notification turn ${event.status}: ${getErrorMessage(event.error)}`,
      });
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        turnId: event.turnId,
        kind: 'notification_failed',
        summary: `notification turn ${event.status}`,
        payload: { notificationId, error: getErrorMessage(event.error) },
      });
      return;
    }

    const rawText = (context.latestAssistantText ?? '').trim();
    const decision = parseNotificationDecision(rawText);

    if (!decision) {
      const attempt = context.attempt ?? 1;
      if (attempt < 2) {
        const notification = this.deps.store.getNotificationById(notificationId);
        if (notification) {
          this.deps.store.appendAudit({
            phoneNumber: this.deps.trustedPhoneNumber,
            turnId: event.turnId,
            kind: 'notification_failed',
            summary: 'notification decision invalid; retrying once',
            payload: { notificationId, attempt },
          });
          await this.startNotificationTurn(notification, attempt + 1);
          return;
        }
      }

      const fallbackText = rawText || 'Notification received, but decision output was invalid.';
      await this.enqueueOutbound(fallbackText);
      this.deps.store.recordNotificationFailure({
        id: notificationId,
        threadId: this.currentSession().threadId,
        turnId: event.turnId,
        errorText: 'notification decision invalid after retry; raw fallback sent',
      });
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        turnId: event.turnId,
        kind: 'notification_failed',
        summary: 'notification decision invalid after retry; sent raw fallback',
        payload: { notificationId, fallback: fallbackText },
      });
      return;
    }

    await this.applyNotificationDecision({
      notificationId,
      turnId: event.turnId,
      decision,
    });
  }

  private async applyNotificationDecision(args: {
    notificationId: string;
    turnId: string;
    decision: NotificationDecision;
  }): Promise<void> {
    const notification = this.deps.store.getNotificationById(args.notificationId);
    const fallbackMessage = notification ? formatNotificationFallbackMessage(notification) : 'Notification received.';
    const resolvedMessage = (args.decision.message ?? '').trim() || fallbackMessage;

    if (args.decision.delivery === 'suppress') {
      this.deps.store.recordNotificationDecision({
        id: args.notificationId,
        status: 'suppressed',
        decision: args.decision,
        threadId: this.currentSession().threadId,
        turnId: args.turnId,
      });
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        turnId: args.turnId,
        kind: 'notification_suppressed',
        summary: 'notification suppressed',
        payload: { notificationId: args.notificationId, reasonCode: args.decision.reasonCode ?? null },
      });
      return;
    }

    await this.enqueueOutbound(resolvedMessage);
    this.deps.store.recordNotificationDecision({
      id: args.notificationId,
      status: 'sent',
      decision: {
        ...args.decision,
        message: resolvedMessage,
      },
      threadId: this.currentSession().threadId,
      turnId: args.turnId,
    });
    this.deps.store.appendAudit({
      phoneNumber: this.deps.trustedPhoneNumber,
      turnId: args.turnId,
      kind: 'notification_sent',
      summary: 'notification sent',
      payload: { notificationId: args.notificationId, reasonCode: args.decision.reasonCode ?? null },
    });
  }

  private maybePruneNotifications(): void {
    const now = Date.now();
    if (now - this.lastNotificationPruneAtMs < BridgeService.NOTIFICATION_PRUNE_INTERVAL_MS) {
      return;
    }

    this.lastNotificationPruneAtMs = now;
    const pruned = this.deps.store.pruneNotifications(
      now,
      this.deps.notificationRetentionDays,
      this.deps.notificationMaxRows,
    );
    if (pruned > 0) {
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        kind: 'system',
        summary: `notification retention prune removed ${pruned} row(s)`,
      });
    }
  }

  private async handleUserText(text: string): Promise<boolean> {
    const flags = this.deps.store.getFlags();
    if (flags.paused) {
      await this.enqueueOutbound('Bridge is paused. Use /resume to continue.');
      return false;
    }

    const session = this.currentSession();
    if (session.activeTurnId) {
      const activeContext = this.turnContexts.get(session.activeTurnId);
      if (activeContext?.mode === 'notification') {
        await this.enqueueOutbound('Processing a notification turn. Please retry in a moment.');
        return false;
      }
    }

    try {
      const result = await this.deps.sessions.startOrSteerTurn(text, flags);
      this.turnContexts.set(result.turnId, { mode: 'user' });
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        threadId: result.threadId,
        turnId: result.turnId,
        kind: result.mode === 'steer' ? 'turn_steered' : 'turn_started',
        summary: `${result.mode} accepted`,
      });
      return true;
    } catch (error) {
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        kind: 'error',
        summary: 'failed to submit input to codex',
        payload: String(error),
      });
      await this.enqueueOutbound(`Failed to submit message: ${String(error)}`);
      return false;
    }
  }

  private async maybeSendReadReceipt(fromNumber: string, summary: string): Promise<void> {
    if (!this.deps.enableReadReceipts) {
      return;
    }

    try {
      await this.deps.sendblue.markRead(fromNumber);
      this.deps.store.appendAudit({
        phoneNumber: fromNumber,
        kind: 'system',
        summary: `read receipt sent: ${summary}`,
      });
    } catch (error) {
      this.deps.store.appendAudit({
        phoneNumber: fromNumber,
        kind: 'error',
        summary: `read receipt failed: ${summary}`,
        payload: String(error),
      });
      logWarn('Failed to send read receipt', error);
    }
  }

  private async maybeSendTypingIndicator(turnId: string, itemId: string): Promise<void> {
    if (!this.deps.enableTypingIndicators) {
      return;
    }

    if (this.typingTurnId !== turnId || this.typingItemId !== itemId) {
      this.typingTurnId = turnId;
      this.typingItemId = itemId;
      this.lastTypingSentAtMs = 0;
    }

    const now = Date.now();
    if (now < this.typingBackoffUntilMs) {
      return;
    }
    if (this.typingSendInFlight) {
      return;
    }
    if (this.lastTypingSentAtMs > 0 && now - this.lastTypingSentAtMs < this.deps.typingHeartbeatMs) {
      return;
    }

    this.typingSendInFlight = true;
    try {
      await this.deps.sendblue.sendTypingIndicator(this.deps.trustedPhoneNumber);
      this.lastTypingSentAtMs = Date.now();
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        threadId: this.currentSession().threadId,
        turnId,
        kind: 'system',
        summary: 'typing indicator sent',
      });
    } catch (error) {
      this.typingBackoffUntilMs = Date.now() + this.typingFailureBackoffMs;
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        threadId: this.currentSession().threadId,
        turnId,
        kind: 'error',
        summary: 'typing indicator failed',
        payload: String(error),
      });
      logWarn('Failed to send typing indicator', error);
    } finally {
      this.typingSendInFlight = false;
    }
  }

  private clearTypingStateForTurn(turnId: string): void {
    if (this.typingTurnId !== turnId) {
      return;
    }
    this.typingTurnId = null;
    this.typingItemId = null;
    this.lastTypingSentAtMs = 0;
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
        this.clearTurnTracking();
        return `Reset complete.\nThread: ${threadId}`;
      }
      case 'debug':
        return this.renderDebugTimeline();
      case 'thread': {
        if (args[0] === 'new') {
          const flags = this.deps.store.getFlags();
          const threadId = await this.deps.sessions.resetAndCreateNewThread(flags);
          this.clearTurnTracking();
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
      case 'notifications':
        return this.renderNotifications(args);
      case 'restart':
        return this.handleRestartCommand(args);
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

  private renderNotifications(args: string[]): string {
    const first = args[0]?.toLowerCase();
    const second = args[1]?.toLowerCase();
    const sourceFromFirst = first && isValidNotificationSource(first) ? first : null;
    const countRaw = sourceFromFirst ? '20' : args[0] ?? '20';
    const sourceRaw = (sourceFromFirst ?? second ?? 'all').toLowerCase();
    const count = Number.parseInt(countRaw, 10);
    if (!Number.isFinite(count) || count < 1 || count > 200) {
      return 'Usage: /notifications [count:1-200] [source:all|webhook|cron|heartbeat]';
    }
    if (!isValidNotificationSource(sourceRaw)) {
      return 'Usage: /notifications [count:1-200] [source:all|webhook|cron|heartbeat]';
    }

    const rows = this.deps.store.listNotifications({
      count,
      source: sourceRaw as NotificationSource | 'all',
    });
    if (rows.length === 0) {
      return 'No notifications found.';
    }

    const lines = [`Notifications (${rows.length})`];
    for (const row of rows) {
      const time = new Date(row.receivedAtMs).toISOString();
      const idShort = row.id.slice(0, 12);
      lines.push(`${time} [${row.source}] [${row.status}] ${idShort} dup=${row.duplicateCount} ${row.summary}`);
    }
    return lines.join('\n');
  }

  private async handleRestartCommand(args: string[]): Promise<string> {
    const target = (args[0] ?? '').toLowerCase();
    if (!target) {
      return 'Usage: /restart <codex|bridge|both>';
    }

    if (target === 'codex') {
      await this.enqueueOutbound('Restarting codex now...');
      const flags = this.deps.store.getFlags();
      const { threadId } = await this.deps.sessions.restartCodex(flags);
      this.clearTurnTracking();
      this.deps.store.appendAudit({
        phoneNumber: this.deps.trustedPhoneNumber,
        kind: 'system',
        summary: 'restart command handled: codex',
        payload: { threadId },
      });
      return `Codex restarted and back online.\nThread: ${threadId ?? '(none)'}`;
    }

    if (target === 'bridge') {
      this.requestBridgeRestart('bridge');
      return 'Restarting bridge now...';
    }

    if (target === 'both') {
      this.requestBridgeRestart('both');
      return 'Restarting bridge and codex now...';
    }

    return 'Usage: /restart <codex|bridge|both>';
  }

  private requestBridgeRestart(target: 'bridge' | 'both'): void {
    this.deps.store.setPendingBridgeRestartNotice(target);
    this.restartRequested = true;
    this.running = false;
    this.clearTurnTracking();
    this.deps.store.appendAudit({
      phoneNumber: this.deps.trustedPhoneNumber,
      kind: 'system',
      summary: `restart command handled: ${target}`,
      payload: { exitCode: 42 },
    });
  }

  private async maybeSendRestartOnlineAnnouncement(): Promise<void> {
    const pending = this.deps.store.consumePendingBridgeRestartNotice();
    if (!pending) {
      return;
    }

    const message =
      pending.target === 'both' ? 'Bridge and codex restarted. Back online.' : 'Bridge restarted. Back online.';
    await this.enqueueOutbound(message);
  }

  private clearTurnTracking(): void {
    this.turnContexts.clear();
    this.typingTurnId = null;
    this.typingItemId = null;
    this.lastTypingSentAtMs = 0;
  }

  private currentSession(): SessionState {
    return this.deps.store.getSession(this.deps.trustedPhoneNumber);
  }

  private logPollLoopError(error: unknown): void {
    const now = Date.now();
    const signature = getErrorMessage(error);
    const withinSuppressionWindow =
      this.lastPollErrorSignature === signature &&
      now - this.lastPollErrorAtMs < BridgeService.POLL_ERROR_SUPPRESSION_WINDOW_MS;

    if (withinSuppressionWindow) {
      this.suppressedPollErrorCount += 1;
      return;
    }

    this.flushSuppressedPollErrors();
    logError('Poll loop error', error);
    this.lastPollErrorSignature = signature;
    this.lastPollErrorAtMs = now;
  }

  private flushSuppressedPollErrors(): void {
    if (this.suppressedPollErrorCount < 1 || !this.lastPollErrorSignature) {
      this.suppressedPollErrorCount = 0;
      return;
    }

    logWarn(`Poll loop error repeated ${this.suppressedPollErrorCount} additional time(s)`, {
      error: this.lastPollErrorSignature,
      windowMs: BridgeService.POLL_ERROR_SUPPRESSION_WINDOW_MS,
    });
    this.suppressedPollErrorCount = 0;
  }

  private async enqueueOutbound(text: string): Promise<void> {
    this.outboundQueue = this.outboundQueue.then(async () => {
      const formatted = formatOutboundForImessage(text, this.deps.enableOutboundUnicodeFormatting);
      const chunks = splitMessage(formatted, 1200);
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

export function formatOutboundForImessage(text: string, enabled = true): string {
  if (!enabled) {
    return text;
  }

  let formatted = text;
  formatted = formatted.replace(/`([^`\n]+)`/g, (_match, inner: string) => styleAsciiAsUnicode(inner, 'mono'));
  formatted = formatted.replace(/\*\*([^*\n][^*]*?)\*\*/g, (_match, inner: string) => styleAsciiAsUnicode(inner, 'bold'));
  formatted = formatted.replace(/__([^_\n][^_]*?)__/g, (_match, inner: string) => styleAsciiAsUnicode(inner, 'bold'));
  formatted = formatted.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_match, prefix: string, inner: string) => {
    return `${prefix}${styleAsciiAsUnicode(inner, 'italic')}`;
  });
  formatted = formatted.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, (_match, prefix: string, inner: string) => {
    return `${prefix}${styleAsciiAsUnicode(inner, 'italic')}`;
  });
  return formatted;
}

type UnicodeStyle = 'bold' | 'italic' | 'mono';

function styleAsciiAsUnicode(text: string, style: UnicodeStyle): string {
  let output = '';
  for (const char of text) {
    output += styleChar(char, style);
  }
  return output;
}

function styleChar(char: string, style: UnicodeStyle): string {
  const code = char.codePointAt(0);
  if (code === undefined) {
    return char;
  }

  if (code >= 0x41 && code <= 0x5a) {
    const upperBase = style === 'bold' ? 0x1d400 : style === 'italic' ? 0x1d434 : 0x1d670;
    return String.fromCodePoint(upperBase + (code - 0x41));
  }

  if (code >= 0x61 && code <= 0x7a) {
    if (style === 'italic' && code === 0x68) {
      return String.fromCodePoint(0x210e);
    }
    const lowerBase = style === 'bold' ? 0x1d41a : style === 'italic' ? 0x1d44e : 0x1d68a;
    return String.fromCodePoint(lowerBase + (code - 0x61));
  }

  if (code >= 0x30 && code <= 0x39) {
    if (style === 'italic') {
      return char;
    }
    const digitBase = style === 'bold' ? 0x1d7ce : 0x1d7f6;
    return String.fromCodePoint(digitBase + (code - 0x30));
  }

  return char;
}

export function composeInboundTextForCodex(
  text: string,
  mediaUrl: string | undefined,
  mode: 'url_only' = 'url_only',
): string {
  const trimmedText = text.trim();
  const trimmedMediaUrl = mediaUrl?.trim() ?? '';

  if (trimmedMediaUrl.length === 0) {
    return trimmedText;
  }

  if (mode === 'url_only') {
    const lines: string[] = [];
    if (trimmedText.length > 0) {
      lines.push(`User message: ${trimmedText}`);
    }
    lines.push(`User attached media URL: ${trimmedMediaUrl}`);
    lines.push('Fetch and inspect this attachment URL as needed.');
    return lines.join('\n');
  }

  return trimmedText;
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

function formatNotificationPrompt(notification: NotificationRecord): string {
  const payloadNote = notification.rawTruncated
    ? `${notification.rawExcerpt}\n[raw payload truncated]`
    : notification.rawExcerpt;

  return [
    'You are processing an inbound notification.',
    'Decide whether to notify the user.',
    'Return ONLY valid JSON matching the output schema for this turn.',
    `notification_id: ${notification.id}`,
    `source: ${notification.source}`,
    `received_at: ${new Date(notification.receivedAtMs).toISOString()}`,
    `summary: ${notification.summary}`,
    `raw_excerpt: ${payloadNote}`,
    'Guidance:',
    '- Use {"delivery":"suppress"} for low-signal/no-actionable events.',
    '- Use {"delivery":"send","message":"..."} for important events.',
    '- Include "reasonCode" when useful.',
  ].join('\n');
}

function formatNotificationFallbackMessage(notification: NotificationRecord): string {
  return `Notification (${notification.source}): ${notification.summary}`;
}

function isValidNotificationSource(value: string): value is NotificationSource | 'all' {
  return value === 'all' || value === 'webhook' || value === 'cron' || value === 'heartbeat';
}

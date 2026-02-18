import { BridgeService } from './bridge.js';
import { loadConfig } from './config.js';
import { CodexRpcClient } from './codex/rpcClient.js';
import { CodexSessionManager } from './codex/sessionManager.js';
import { logError, logInfo } from './logger.js';
import { NotificationWebhookServer } from './notifications/webhookServer.js';
import { SendblueClient } from './sendblue/client.js';
import { StateStore } from './state/store.js';

const EXIT_CODE_RESTART = 42;

async function main(): Promise<void> {
  const config = loadConfig();

  const store = new StateStore(config.stateDbPath, config.codex.defaultModel);

  const sendblue = new SendblueClient({
    apiBase: config.sendblue.apiBase,
    apiKey: config.sendblue.apiKey,
    apiSecret: config.sendblue.apiSecret,
    fromPhoneNumber: config.sendblue.phoneNumber,
  });

  const rpc = new CodexRpcClient({
    codexBin: config.codex.bin,
    cwd: config.codex.cwd,
    clientName: 'imessage_codex_bridge',
    clientTitle: 'iMessage Codex Bridge',
    clientVersion: '0.2.0',
  });

  const sessions = new CodexSessionManager({
    rpc,
    store,
    trustedPhoneNumber: config.trustedPhoneNumber,
    defaultModel: config.codex.defaultModel,
    modelPrefix: config.codex.modelPrefix,
    cwd: config.codex.cwd,
  });

  const bridge = new BridgeService({
    sendblue,
    store,
    sessions,
    trustedPhoneNumber: config.trustedPhoneNumber,
    pollIntervalMs: config.sendblue.pollIntervalMs,
    modelPrefix: config.codex.modelPrefix,
    enableTypingIndicators: config.bridge.enableTypingIndicators,
    enableReadReceipts: config.bridge.enableReadReceipts,
    enableOutboundUnicodeFormatting: config.bridge.enableOutboundUnicodeFormatting,
    discardBacklogOnStart: config.bridge.discardBacklogOnStart,
    inboundMediaMode: config.bridge.inboundMediaMode,
    typingHeartbeatMs: config.bridge.typingHeartbeatMs,
    notificationTurnsEnabled: config.notifications.enabled,
    notificationRawExcerptBytes: config.notifications.rawExcerptBytes,
    notificationRetentionDays: config.notifications.retentionDays,
    notificationMaxRows: config.notifications.maxRows,
  });

  const webhookServer = new NotificationWebhookServer({
    enabled: config.notifications.webhook.enabled,
    host: config.notifications.webhook.host,
    port: config.notifications.webhook.port,
    path: config.notifications.webhook.path,
    secret: config.notifications.webhook.secret,
    onNotification: async (input) => {
      const result = await bridge.ingestNotification({
        payload: input.payload,
        source: 'webhook',
        sourceAccount: input.sourceAccount,
        sourceEventId: input.sourceEventId,
      });
      return {
        notificationId: result.notificationId,
        duplicate: result.duplicate,
      };
    },
  });

  let shuttingDown = false;
  const finalizeAndExit = async (exitCode: number, reason: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo(`Finalizing bridge runtime (${reason})...`);

    try {
      await bridge.stop();
      await webhookServer.stop();
      store.close();
    } catch (error) {
      logError('Shutdown error', error);
    } finally {
      process.exit(exitCode);
    }
  };

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    logInfo(`Received ${signal}, shutting down...`);
    await finalizeAndExit(0, signal);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  logInfo('Starting iMessage Codex Bridge');
  logInfo(`Trusted phone: ${config.trustedPhoneNumber}`);
  logInfo(`Poll interval: ${config.sendblue.pollIntervalMs}ms`);
  logInfo(`Model prefix policy: ${config.codex.modelPrefix}`);
  logInfo(`Codex cwd: ${config.codex.cwd}`);
  logInfo(`Typing indicators: ${config.bridge.enableTypingIndicators}`);
  logInfo(`Read receipts: ${config.bridge.enableReadReceipts}`);
  logInfo(`Outbound unicode formatting: ${config.bridge.enableOutboundUnicodeFormatting}`);
  logInfo(`Discard startup backlog: ${config.bridge.discardBacklogOnStart}`);
  logInfo(`Notification turns enabled: ${config.notifications.enabled}`);
  logInfo(`Notification webhook enabled: ${config.notifications.webhook.enabled}`);

  await webhookServer.start();
  await bridge.start();
  const restartRequested = bridge.consumeRestartRequested();
  if (restartRequested) {
    logInfo(`Bridge restart requested; exiting with ${EXIT_CODE_RESTART} for supervisor relaunch.`);
    await finalizeAndExit(EXIT_CODE_RESTART, 'restart requested');
    return;
  }

  await finalizeAndExit(0, 'bridge loop ended');
}

void main().catch((error) => {
  logError('Fatal startup error', error);
  process.exit(1);
});

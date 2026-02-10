import { BridgeService } from './bridge.js';
import { loadConfig } from './config.js';
import { CodexRpcClient } from './codex/rpcClient.js';
import { CodexSessionManager } from './codex/sessionManager.js';
import { logError, logInfo } from './logger.js';
import { SendblueClient } from './sendblue/client.js';
import { StateStore } from './state/store.js';

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
    clientVersion: '0.1.0',
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
    inboundMediaMode: config.bridge.inboundMediaMode,
    typingHeartbeatMs: config.bridge.typingHeartbeatMs,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logInfo(`Received ${signal}, shutting down...`);

    try {
      await bridge.stop();
      store.close();
    } catch (error) {
      logError('Shutdown error', error);
    } finally {
      process.exit(0);
    }
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

  await bridge.start();
}

void main().catch((error) => {
  logError('Fatal startup error', error);
  process.exit(1);
});

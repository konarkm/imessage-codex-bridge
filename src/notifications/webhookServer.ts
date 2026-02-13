import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { logError, logInfo, logWarn } from '../logger.js';

interface NotificationWebhookServerOptions {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
  secret: string;
  maxBodyBytes?: number;
  onNotification: (input: {
    payload: unknown;
    sourceAccount?: string | null;
    sourceEventId?: string | null;
  }) => Promise<{ notificationId: string; duplicate: boolean }>;
}

export class NotificationWebhookServer {
  private readonly opts: NotificationWebhookServerOptions;
  private readonly maxBodyBytes: number;
  private server: Server | null = null;

  constructor(opts: NotificationWebhookServerOptions) {
    this.opts = opts;
    this.maxBodyBytes = Math.max(1024, Math.floor(opts.maxBodyBytes ?? 1024 * 1024));
  }

  async start(): Promise<void> {
    if (!this.opts.enabled || this.server) {
      return;
    }

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        reject(new Error('Webhook server missing'));
        return;
      }
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.server?.off('error', reject);
        resolve();
      });
    });

    logInfo(`Notification webhook listening on http://${this.opts.host}:${this.opts.port}${this.opts.path}`);
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== this.opts.path) {
      this.respondJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    if (req.method !== 'POST') {
      this.respondJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }

    if (!this.isAuthorized(req)) {
      this.respondJson(res, 401, { ok: false, error: 'Unauthorized' });
      return;
    }

    let payload: unknown;
    try {
      const body = await this.readBody(req);
      payload = JSON.parse(body);
    } catch (error) {
      this.respondJson(res, 400, { ok: false, error: getErrorMessage(error) });
      return;
    }

    try {
      const sourceAccount = this.headerValue(req, 'x-source-account');
      const sourceEventId = this.headerValue(req, 'x-event-id');
      const result = await this.opts.onNotification({
        payload,
        sourceAccount,
        sourceEventId,
      });
      this.respondJson(res, 200, {
        ok: true,
        notificationId: result.notificationId,
        duplicate: result.duplicate,
      });
    } catch (error) {
      logError('Notification webhook handler failed', error);
      this.respondJson(res, 500, { ok: false, error: 'Internal error' });
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const authHeader = this.headerValue(req, 'authorization');
    if (authHeader) {
      const token = authHeader.replace(/^bearer\s+/i, '').trim();
      if (token.length > 0) {
        return token === this.opts.secret;
      }
    }
    const secretHeader = this.headerValue(req, 'x-bridge-secret');
    if (secretHeader) {
      return secretHeader === this.opts.secret;
    }
    return false;
  }

  private async readBody(req: IncomingMessage): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          req.destroy();
          reject(new Error('payload too large'));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });

      req.on('error', (error) => {
        reject(error);
      });
    });
  }

  private headerValue(req: IncomingMessage, name: string): string | null {
    const value = req.headers[name];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (Array.isArray(value) && value.length > 0 && value[0] && value[0].trim().length > 0) {
      return value[0].trim();
    }
    return null;
  }

  private respondJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

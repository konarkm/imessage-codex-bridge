import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logError, logInfo, logWarn } from '../logger.js';
import type {
  JsonRpcErrorResponse,
  JsonRpcId,
  JsonRpcIncoming,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from '../types.js';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CodexRpcClientOptions {
  codexBin: string;
  cwd: string;
  clientName: string;
  clientTitle: string;
  clientVersion: string;
}

export interface RpcNotificationEvent {
  method: string;
  params: unknown;
}

export interface RpcServerRequestEvent {
  id: JsonRpcId;
  method: string;
  params: unknown;
}

export class CodexRpcClient extends EventEmitter {
  private readonly opts: CodexRpcClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private stdoutBuffer = '';
  private started = false;

  constructor(opts: CodexRpcClientOptions) {
    super();
    this.opts = opts;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.child = spawn(this.opts.codexBin, ['app-server'], {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');

    this.child.stdout.on('data', (chunk: string) => {
      this.handleStdout(chunk);
    });

    this.child.stderr.on('data', (chunk: string) => {
      this.emit('stderr', chunk);
      const lines = chunk.split(/\r?\n/).filter((line) => line.trim().length > 0);
      for (const line of lines) {
        logWarn(`codex stderr: ${line}`);
      }
    });

    this.child.on('exit', (code, signal) => {
      this.started = false;
      this.rejectPending(new Error(`codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
      this.emit('exit', { code, signal });
    });

    this.child.on('error', (error) => {
      this.started = false;
      this.rejectPending(error);
      this.emit('error', error);
    });

    this.started = true;
    logInfo('Started codex app-server process');

    await this.request('initialize', {
      clientInfo: {
        name: this.opts.clientName,
        title: this.opts.clientTitle,
        version: this.opts.clientVersion,
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    await this.notify('initialized', {});
    logInfo('Codex app-server initialized');
  }

  async stop(): Promise<void> {
    this.started = false;
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;

    try {
      child.kill('SIGTERM');
    } catch (error) {
      logWarn('Failed to SIGTERM codex app-server', error);
    }
  }

  async request<T>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    this.ensureStarted();
    const id = this.nextId++;

    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const resultPromise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC request timed out: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    this.writeMessage(req);
    return resultPromise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.ensureStarted();
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.writeMessage(notification);
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    this.ensureStarted();
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  async respondError(id: JsonRpcId | null, code: number, message: string, data?: unknown): Promise<void> {
    this.ensureStarted();
    this.writeMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message,
        data,
      },
    });
  }

  private ensureStarted(): void {
    if (!this.started || !this.child || !this.child.stdin.writable) {
      throw new Error('codex app-server is not started');
    }
  }

  private writeMessage(message: unknown): void {
    if (!this.child) {
      throw new Error('codex child missing');
    }

    const payload = `${JSON.stringify(message)}\n`;
    this.child.stdin.write(payload);
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcIncoming;
    try {
      parsed = JSON.parse(line) as JsonRpcIncoming;
    } catch (error) {
      logWarn('Failed to parse codex JSON-RPC line', { line, error });
      return;
    }

    if ('id' in parsed && 'result' in parsed) {
      this.handleSuccessResponse(parsed);
      return;
    }

    if ('id' in parsed && 'error' in parsed) {
      this.handleErrorResponse(parsed);
      return;
    }

    if ('id' in parsed && 'method' in parsed) {
      const req = parsed as JsonRpcRequest;
      this.emit('request', {
        id: req.id,
        method: req.method,
        params: req.params,
      } satisfies RpcServerRequestEvent);
      return;
    }

    if ('method' in parsed) {
      const notification = parsed as JsonRpcNotification;
      this.emit('notification', {
        method: notification.method,
        params: notification.params,
      } satisfies RpcNotificationEvent);
      return;
    }

    logWarn('Received unknown JSON-RPC shape', parsed);
  }

  private handleSuccessResponse(response: JsonRpcSuccessResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) {
      logWarn(`Unexpected RPC response id=${String(response.id)}`);
      return;
    }

    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.resolve(response.result);
  }

  private handleErrorResponse(response: JsonRpcErrorResponse): void {
    if (response.id === null) {
      logError('Server emitted JSON-RPC error notification', response.error);
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) {
      logWarn(`Unexpected RPC error id=${String(response.id)}`, response.error);
      return;
    }

    this.pending.delete(response.id);
    clearTimeout(pending.timer);
    pending.reject(new Error(`RPC error ${response.error.code}: ${response.error.message}`));
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

import { z } from 'zod';
import type { SendblueMessage } from '../types.js';
import { normalizePhone, sleep } from '../utils.js';

interface SendblueConfig {
  apiBase: string;
  apiKey: string;
  apiSecret: string;
  fromPhoneNumber: string;
  inboundRequestTimeoutMs?: number;
  inboundMaxAttempts?: number;
  inboundInitialBackoffMs?: number;
  inboundMaxBackoffMs?: number;
}

const phoneFieldSchema = z
  .union([z.string(), z.array(z.string()), z.null(), z.undefined()])
  .transform((value) => {
    if (typeof value === 'string') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.find((entry) => typeof entry === 'string' && entry.trim().length > 0) ?? '';
    }
    return '';
  });

const optionalPhoneFieldSchema = z
  .union([z.string(), z.array(z.string()), z.null(), z.undefined()])
  .transform((value) => {
    if (typeof value === 'string') {
      return value.trim().length > 0 ? value : undefined;
    }
    if (Array.isArray(value)) {
      const found = value.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
      return found ?? undefined;
    }
    return undefined;
  });

const messageSchema = z.object({
  message_handle: z.string(),
  content: z.string().nullish().transform((value) => value ?? ''),
  from_number: phoneFieldSchema,
  to_number: phoneFieldSchema,
  number: optionalPhoneFieldSchema,
  status: z.string().optional(),
  date_sent: z.string().optional(),
  date_updated: z.string().optional(),
  created_at: z.string().optional(),
  is_outbound: z.boolean(),
  media_url: z.string().nullish().transform((value) => value ?? undefined),
});

const listSchema = z.object({
  data: z.array(messageSchema).default([]),
});

const sendResponseSchema = z.object({
  message_handle: z.string().optional(),
  id: z.string().optional(),
});

export class SendblueClient {
  private static readonly DEFAULT_INBOUND_REQUEST_TIMEOUT_MS = 10_000;
  private static readonly DEFAULT_INBOUND_MAX_ATTEMPTS = 3;
  private static readonly DEFAULT_INBOUND_INITIAL_BACKOFF_MS = 500;
  private static readonly DEFAULT_INBOUND_MAX_BACKOFF_MS = 4_000;
  private static readonly RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly fromPhoneNumber: string;
  private readonly inboundRequestTimeoutMs: number;
  private readonly inboundMaxAttempts: number;
  private readonly inboundInitialBackoffMs: number;
  private readonly inboundMaxBackoffMs: number;

  constructor(config: SendblueConfig) {
    this.apiBase = config.apiBase;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.fromPhoneNumber = normalizePhone(config.fromPhoneNumber);
    this.inboundRequestTimeoutMs = Math.max(100, config.inboundRequestTimeoutMs ?? SendblueClient.DEFAULT_INBOUND_REQUEST_TIMEOUT_MS);
    this.inboundMaxAttempts = Math.max(1, config.inboundMaxAttempts ?? SendblueClient.DEFAULT_INBOUND_MAX_ATTEMPTS);
    this.inboundInitialBackoffMs = Math.max(
      0,
      config.inboundInitialBackoffMs ?? SendblueClient.DEFAULT_INBOUND_INITIAL_BACKOFF_MS,
    );
    this.inboundMaxBackoffMs = Math.max(
      this.inboundInitialBackoffMs,
      config.inboundMaxBackoffMs ?? SendblueClient.DEFAULT_INBOUND_MAX_BACKOFF_MS,
    );
  }

  async getInboundMessages(limit = 100): Promise<SendblueMessage[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    const endpoint = `${this.apiBase}/v2/messages?${params.toString()}`;

    for (let attempt = 1; attempt <= this.inboundMaxAttempts; attempt += 1) {
      try {
        const response = await this.fetchWithTimeout(endpoint, {
          method: 'GET',
          headers: this.authHeaders(),
        });

        if (!response.ok) {
          const body = await response.text();
          const error = new Error(`Sendblue fetch failed: ${response.status} ${body}`);
          if (this.isRetryableStatus(response.status) && attempt < this.inboundMaxAttempts) {
            await this.sleepBeforeRetry(attempt);
            continue;
          }
          throw error;
        }

        const raw = await response.json();
        const parsed = listSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(`Unexpected Sendblue list response: ${parsed.error.message}`);
        }

        return parsed.data.data
          .filter((m) => !m.is_outbound)
          .map((m) => ({
            ...m,
            from_number: normalizePhone(m.from_number),
            to_number: normalizePhone(m.to_number),
          }));
      } catch (error) {
        if (!this.isRetryableError(error) || attempt >= this.inboundMaxAttempts) {
          throw error;
        }
        await this.sleepBeforeRetry(attempt);
      }
    }

    throw new Error('Sendblue fetch failed after retries');
  }

  async sendMessage(toNumber: string, content: string): Promise<string> {
    const target = normalizePhone(toNumber);
    const response = await fetch(`${this.apiBase}/send-message`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        number: target,
        from_number: this.fromPhoneNumber,
        content,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sendblue send failed: ${response.status} ${body}`);
    }

    const raw = await response.json();
    const parsed = sendResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Unexpected Sendblue send response: ${parsed.error.message}`);
    }

    return parsed.data.message_handle ?? parsed.data.id ?? '';
  }

  async sendTypingIndicator(toNumber: string): Promise<void> {
    const target = normalizePhone(toNumber);
    const response = await fetch(`${this.apiBase}/send-typing-indicator`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        number: target,
        from_number: this.fromPhoneNumber,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sendblue typing indicator failed: ${response.status} ${body}`);
    }
  }

  async markRead(number: string): Promise<void> {
    const target = normalizePhone(number);
    const response = await fetch(`${this.apiBase}/mark-read`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        number: target,
        from_number: this.fromPhoneNumber,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sendblue mark-read failed: ${response.status} ${body}`);
    }
  }

  private authHeaders(): HeadersInit {
    return {
      'sb-api-key-id': this.apiKey,
      'sb-api-secret-key': this.apiSecret,
    };
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.inboundRequestTimeoutMs);
    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (this.isAbortError(error)) {
        throw new Error(`Sendblue fetch timed out after ${this.inboundRequestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private isRetryableStatus(status: number): boolean {
    return SendblueClient.RETRYABLE_STATUSES.has(status);
  }

  private isRetryableError(error: unknown): boolean {
    if (this.isAbortError(error)) {
      return true;
    }
    if (!error || typeof error !== 'object') {
      return false;
    }
    const record = error as Record<string, unknown>;
    if (record.name === 'TypeError') {
      return true;
    }
    if (typeof record.message === 'string' && /timed out|network|fetch/i.test(record.message)) {
      return true;
    }
    return false;
  }

  private isAbortError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    const record = error as Record<string, unknown>;
    return record.name === 'AbortError';
  }

  private async sleepBeforeRetry(attempt: number): Promise<void> {
    if (this.inboundInitialBackoffMs === 0) {
      return;
    }
    const exponentialMs = this.inboundInitialBackoffMs * 2 ** Math.max(0, attempt - 1);
    const cappedMs = Math.min(this.inboundMaxBackoffMs, exponentialMs);
    const jitterMs = Math.floor(Math.random() * Math.max(1, Math.floor(cappedMs * 0.2)));
    await sleep(cappedMs + jitterMs);
  }
}

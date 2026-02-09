import { z } from 'zod';
import type { SendblueMessage } from '../types.js';
import { normalizePhone } from '../utils.js';

interface SendblueConfig {
  apiBase: string;
  apiKey: string;
  apiSecret: string;
  fromPhoneNumber: string;
}

const messageSchema = z.object({
  message_handle: z.string(),
  content: z.string().default(''),
  from_number: z.string(),
  to_number: z.string().default(''),
  number: z.string().optional(),
  status: z.string().optional(),
  date_sent: z.string().optional(),
  date_updated: z.string().optional(),
  created_at: z.string().optional(),
  is_outbound: z.boolean(),
  media_url: z.string().optional(),
});

const listSchema = z.object({
  data: z.array(messageSchema).default([]),
});

const sendResponseSchema = z.object({
  message_handle: z.string().optional(),
  id: z.string().optional(),
});

export class SendblueClient {
  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly fromPhoneNumber: string;

  constructor(config: SendblueConfig) {
    this.apiBase = config.apiBase;
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.fromPhoneNumber = normalizePhone(config.fromPhoneNumber);
  }

  async getInboundMessages(limit = 100): Promise<SendblueMessage[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    const response = await fetch(`${this.apiBase}/v2/messages?${params.toString()}`, {
      method: 'GET',
      headers: this.authHeaders(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Sendblue fetch failed: ${response.status} ${body}`);
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

  private authHeaders(): HeadersInit {
    return {
      'sb-api-key-id': this.apiKey,
      'sb-api-secret-key': this.apiSecret,
    };
  }
}

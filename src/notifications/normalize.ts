import { createHash, randomUUID } from 'node:crypto';
import { nowMs } from '../utils.js';
import type { NotificationEvent, NotificationSource } from './types.js';

const SUMMARY_MAX_CHARS = 220;

interface NormalizeNotificationInput {
  payload: unknown;
  source?: NotificationSource;
  sourceAccount?: string | null;
  sourceEventId?: string | null;
  receivedAtMs?: number;
  rawExcerptBytes?: number;
}

export function normalizeNotification(input: NormalizeNotificationInput): NotificationEvent {
  const source = input.source ?? 'webhook';
  const receivedAt = input.receivedAtMs ?? nowMs();
  const payloadText = stringifyPayload(input.payload);
  const payloadHash = sha256(payloadText);

  const derivedSourceEventId = coalesceString(
    input.sourceEventId,
    extractObjectField(input.payload, ['event_id', 'eventId', 'id', 'message_handle']),
  );
  const sourceAccount = coalesceString(
    input.sourceAccount,
    extractObjectField(input.payload, ['source_account', 'sourceAccount', 'account', 'account_id', 'accountId']),
  );

  const rawExcerptBytes = clampRawExcerptBytes(input.rawExcerptBytes);
  const rawSizeBytes = Buffer.byteLength(payloadText, 'utf8');
  const rawExcerpt = Buffer.from(payloadText, 'utf8').subarray(0, rawExcerptBytes).toString('utf8');
  const rawTruncated = rawSizeBytes > rawExcerptBytes;

  const dedupeKey = derivedSourceEventId
    ? `event:${source}:${sourceAccount ?? '-'}:${derivedSourceEventId}`
    : `hash:${source}:${sourceAccount ?? '-'}:${payloadHash}`;

  return {
    id: `nfy_${randomUUID().replace(/-/g, '')}`,
    source,
    sourceAccount: sourceAccount ?? null,
    sourceEventId: derivedSourceEventId ?? null,
    dedupeKey,
    status: 'queued',
    receivedAtMs: receivedAt,
    summary: summarizePayload(input.payload),
    payloadHash,
    rawExcerpt,
    rawSizeBytes,
    rawTruncated,
    firstSeenAtMs: receivedAt,
    lastSeenAtMs: receivedAt,
  };
}

function stringifyPayload(payload: unknown): string {
  if (payload === null || payload === undefined) {
    return 'null';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (typeof payload === 'number' || typeof payload === 'boolean') {
    return String(payload);
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function summarizePayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return clip(payload.trim(), SUMMARY_MAX_CHARS) || '(string payload)';
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const summaryCandidate = extractObjectField(payload, [
      'summary',
      'message',
      'text',
      'title',
      'event',
      'type',
      'kind',
    ]);
    if (summaryCandidate) {
      return clip(summaryCandidate, SUMMARY_MAX_CHARS);
    }

    const keys = Object.keys(payload as Record<string, unknown>);
    if (keys.length === 0) {
      return 'webhook payload (empty object)';
    }
    return clip(`webhook payload keys: ${keys.slice(0, 8).join(', ')}`, SUMMARY_MAX_CHARS);
  }

  if (Array.isArray(payload)) {
    return clip(`webhook payload array (${payload.length} item${payload.length === 1 ? '' : 's'})`, SUMMARY_MAX_CHARS);
  }

  return clip(String(payload), SUMMARY_MAX_CHARS);
}

function extractObjectField(payload: unknown, keys: string[]): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function coalesceString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function clip(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function clampRawExcerptBytes(value: number | undefined): number {
  if (value === undefined) {
    return 4096;
  }
  return Math.min(32768, Math.max(256, Math.floor(value)));
}

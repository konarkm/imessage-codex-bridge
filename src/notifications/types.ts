export type NotificationSource = 'webhook' | 'cron' | 'heartbeat';

export type NotificationStatus =
  | 'received'
  | 'queued'
  | 'processing'
  | 'sent'
  | 'suppressed'
  | 'failed'
  | 'duplicate';

export type NotificationDelivery = 'send' | 'suppress';

export interface NotificationEvent {
  id: string;
  source: NotificationSource;
  sourceAccount: string | null;
  sourceEventId: string | null;
  dedupeKey: string;
  status: NotificationStatus;
  receivedAtMs: number;
  summary: string;
  payloadHash: string;
  rawExcerpt: string;
  rawSizeBytes: number;
  rawTruncated: boolean;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

export interface NotificationDecision {
  delivery: NotificationDelivery;
  message?: string;
  reasonCode?: string;
}

export interface NotificationRecord extends NotificationEvent {
  processedAtMs: number | null;
  delivery: NotificationDelivery | null;
  reasonCode: string | null;
  messageExcerpt: string | null;
  duplicateCount: number;
  threadId: string | null;
  turnId: string | null;
  decision: NotificationDecision | null;
  errorText: string | null;
}

export interface NotificationListQuery {
  count: number;
  source?: NotificationSource | 'all';
}

export interface NotificationSearchQuery {
  source?: NotificationSource | 'all';
  status?: NotificationStatus;
  sinceMs?: number;
  limit: number;
}

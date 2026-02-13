import { DatabaseSync } from 'node:sqlite';
import type { NotificationDecision, NotificationEvent, NotificationListQuery, NotificationRecord, NotificationSearchQuery } from '../notifications/types.js';
import type { AuditEvent, AuditKind, BridgeFlags, ReasoningEffort, SessionState } from '../types.js';
import { ensureDirForFile, nowMs } from '../utils.js';

interface SessionRow {
  phone_number: string;
  thread_id: string | null;
  active_turn_id: string | null;
  model: string;
  updated_at_ms: number;
}

interface AuditRow {
  id: number;
  ts_ms: number;
  phone_number: string | null;
  thread_id: string | null;
  turn_id: string | null;
  kind: AuditKind;
  summary: string;
  payload_json: string;
}

interface NotificationRow {
  id: string;
  source: string;
  source_account: string | null;
  source_event_id: string | null;
  dedupe_key: string;
  status: string;
  received_at_ms: number;
  processed_at_ms: number | null;
  delivery: string | null;
  reason_code: string | null;
  message_excerpt: string | null;
  summary: string;
  payload_hash: string;
  raw_excerpt: string;
  raw_size_bytes: number;
  raw_truncated: number;
  duplicate_count: number;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  thread_id: string | null;
  turn_id: string | null;
  decision_json: string | null;
  error_text: string | null;
}

export interface PendingBridgeRestartNotice {
  target: 'bridge' | 'both';
  requestedAtMs: number;
}

interface SparkReturnTarget {
  model: string;
  effort: ReasoningEffort;
}

const REASONING_EFFORT_LEVELS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export class StateStore {
  private static readonly SCHEMA_VERSION = 2;

  private readonly db: DatabaseSync;
  private readonly defaultModel: string;

  constructor(dbPath: string, defaultModel: string) {
    ensureDirForFile(dbPath);
    this.db = new DatabaseSync(dbPath);
    this.defaultModel = defaultModel;
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.createSchema();
  }

  close(): void {
    this.db.close();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        phone_number TEXT PRIMARY KEY,
        thread_id TEXT,
        active_turn_id TEXT,
        model TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbound_messages (
        message_handle TEXT PRIMARY KEY,
        received_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS flags (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_ms INTEGER NOT NULL,
        phone_number TEXT,
        thread_id TEXT,
        turn_id TEXT,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);

    this.ensureNotificationSchema();
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    const currentVersion = Number(row?.user_version ?? 0);
    if (currentVersion < StateStore.SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${StateStore.SCHEMA_VERSION};`);
    }
  }

  private ensureNotificationSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_account TEXT,
        source_event_id TEXT,
        dedupe_key TEXT NOT NULL,
        status TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL,
        processed_at_ms INTEGER,
        delivery TEXT,
        reason_code TEXT,
        message_excerpt TEXT,
        summary TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        raw_excerpt TEXT NOT NULL,
        raw_size_bytes INTEGER NOT NULL,
        raw_truncated INTEGER NOT NULL,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at_ms INTEGER NOT NULL,
        last_seen_at_ms INTEGER NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        decision_json TEXT,
        error_text TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe_key_unique ON notifications(dedupe_key);
      CREATE INDEX IF NOT EXISTS idx_notifications_received_at ON notifications(received_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_source_received_at ON notifications(source, received_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_notifications_status_received_at ON notifications(status, received_at_ms DESC);
    `);
  }

  private ensureSession(phoneNumber: string): void {
    const now = nowMs();
    this.db
      .prepare(
        `INSERT INTO sessions(phone_number, thread_id, active_turn_id, model, updated_at_ms)
         VALUES (?, NULL, NULL, ?, ?)
         ON CONFLICT(phone_number) DO NOTHING`,
      )
      .run(phoneNumber, this.defaultModel, now);
  }

  getSession(phoneNumber: string): SessionState {
    this.ensureSession(phoneNumber);
    const row = this.db
      .prepare(
        `SELECT phone_number, thread_id, active_turn_id, model, updated_at_ms
         FROM sessions WHERE phone_number = ?`,
      )
      .get(phoneNumber) as SessionRow | undefined;

    if (!row) {
      throw new Error(`session row missing for ${phoneNumber}`);
    }

    return {
      phoneNumber: row.phone_number,
      threadId: row.thread_id,
      activeTurnId: row.active_turn_id,
      model: row.model,
      updatedAtMs: row.updated_at_ms,
    };
  }

  setThreadId(phoneNumber: string, threadId: string): void {
    this.ensureSession(phoneNumber);
    const now = nowMs();
    this.db.prepare('UPDATE sessions SET thread_id = ?, updated_at_ms = ? WHERE phone_number = ?').run(threadId, now, phoneNumber);
  }

  setActiveTurn(phoneNumber: string, turnId: string): void {
    this.ensureSession(phoneNumber);
    const now = nowMs();
    this.db
      .prepare('UPDATE sessions SET active_turn_id = ?, updated_at_ms = ? WHERE phone_number = ?')
      .run(turnId, now, phoneNumber);
  }

  clearActiveTurn(phoneNumber: string): void {
    this.ensureSession(phoneNumber);
    const now = nowMs();
    this.db
      .prepare('UPDATE sessions SET active_turn_id = NULL, updated_at_ms = ? WHERE phone_number = ?')
      .run(now, phoneNumber);
  }

  setModel(phoneNumber: string, model: string): void {
    this.ensureSession(phoneNumber);
    const now = nowMs();
    this.db.prepare('UPDATE sessions SET model = ?, updated_at_ms = ? WHERE phone_number = ?').run(model, now, phoneNumber);
  }

  resetRuntime(phoneNumber: string): void {
    this.ensureSession(phoneNumber);
    const now = nowMs();
    this.db
      .prepare('UPDATE sessions SET thread_id = NULL, active_turn_id = NULL, updated_at_ms = ? WHERE phone_number = ?')
      .run(now, phoneNumber);
  }

  isMessageProcessed(messageHandle: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM inbound_messages WHERE message_handle = ?').get(messageHandle) as { 1: number } | undefined;
    return row !== undefined;
  }

  hasProcessedMessages(): boolean {
    const row = this.db.prepare('SELECT 1 AS present FROM inbound_messages LIMIT 1').get() as { present: number } | undefined;
    return row !== undefined;
  }

  markMessageProcessed(messageHandle: string): boolean {
    const now = nowMs();
    const result = this.db.prepare('INSERT OR IGNORE INTO inbound_messages(message_handle, received_at_ms) VALUES (?, ?)').run(messageHandle, now);
    return result.changes > 0;
  }

  markMessagesProcessed(messageHandles: string[]): number {
    let inserted = 0;
    for (const handle of messageHandles) {
      if (this.markMessageProcessed(handle)) {
        inserted += 1;
      }
    }
    return inserted;
  }

  getFlags(): BridgeFlags {
    const paused = this.getFlag('paused', '0') === '1';
    const autoApprove = this.getFlag('auto_approve', '1') === '1';
    return { paused, autoApprove };
  }

  setPaused(value: boolean): void {
    this.setFlag('paused', value ? '1' : '0');
  }

  setAutoApprove(value: boolean): void {
    this.setFlag('auto_approve', value ? '1' : '0');
  }

  getReasoningEffortForModel(model: string): ReasoningEffort {
    const map = this.getReasoningEffortMap();
    return map[model] ?? defaultReasoningEffortForModel(model);
  }

  setReasoningEffortForModel(model: string, effort: ReasoningEffort): void {
    if (!REASONING_EFFORT_LEVELS.includes(effort)) {
      throw new Error(`Unsupported reasoning effort: ${effort}`);
    }
    const map = this.getReasoningEffortMap();
    map[model] = effort;
    this.setFlag('reasoning_effort_by_model', JSON.stringify(map));
  }

  setSparkReturnTarget(target: SparkReturnTarget): void {
    this.setFlag('spark_return_target', JSON.stringify(target));
  }

  getSparkReturnTarget(): SparkReturnTarget | null {
    const row = this.db.prepare('SELECT value FROM flags WHERE key = ?').get('spark_return_target') as { value: string } | undefined;
    if (!row) {
      return null;
    }
    return parseSparkReturnTarget(row.value);
  }

  clearSparkReturnTarget(): void {
    this.db.prepare('DELETE FROM flags WHERE key = ?').run('spark_return_target');
  }

  setPendingBridgeRestartNotice(target: PendingBridgeRestartNotice['target']): void {
    const payload: PendingBridgeRestartNotice = {
      target,
      requestedAtMs: nowMs(),
    };
    this.setFlag('pending_bridge_restart_notice', JSON.stringify(payload));
  }

  consumePendingBridgeRestartNotice(): PendingBridgeRestartNotice | null {
    const row = this.db
      .prepare('SELECT value FROM flags WHERE key = ?')
      .get('pending_bridge_restart_notice') as { value: string } | undefined;

    if (!row) {
      return null;
    }

    this.db.prepare('DELETE FROM flags WHERE key = ?').run('pending_bridge_restart_notice');
    return parsePendingBridgeRestartNotice(row.value);
  }

  private getFlag(key: string, defaultValue: string): string {
    const row = this.db.prepare('SELECT value FROM flags WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) {
      this.setFlag(key, defaultValue);
      return defaultValue;
    }
    return row.value;
  }

  private setFlag(key: string, value: string): void {
    const now = nowMs();
    this.db
      .prepare(
        `INSERT INTO flags(key, value, updated_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(key)
         DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(key, value, now);
  }

  private getReasoningEffortMap(): Record<string, ReasoningEffort> {
    const row = this.db.prepare('SELECT value FROM flags WHERE key = ?').get('reasoning_effort_by_model') as { value: string } | undefined;
    if (!row) {
      return {};
    }

    try {
      const parsed = JSON.parse(row.value) as Record<string, unknown>;
      const result: Record<string, ReasoningEffort> = {};
      for (const [model, effort] of Object.entries(parsed)) {
        if (typeof effort === 'string' && REASONING_EFFORT_LEVELS.includes(effort as ReasoningEffort)) {
          result[model] = effort as ReasoningEffort;
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  appendAudit(entry: {
    phoneNumber?: string | null;
    threadId?: string | null;
    turnId?: string | null;
    kind: AuditKind;
    summary: string;
    payload?: unknown;
  }): void {
    const payloadJson = JSON.stringify(entry.payload ?? null);
    this.db
      .prepare(
        `INSERT INTO audit_events(ts_ms, phone_number, thread_id, turn_id, kind, summary, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nowMs(), entry.phoneNumber ?? null, entry.threadId ?? null, entry.turnId ?? null, entry.kind, entry.summary, payloadJson);
  }

  getLastTurnTimeline(phoneNumber: string, limit = 50): AuditEvent[] {
    const lastTurnRow = this.db
      .prepare(
        `SELECT turn_id FROM audit_events
         WHERE phone_number = ? AND turn_id IS NOT NULL
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(phoneNumber) as { turn_id: string } | undefined;

    if (!lastTurnRow) {
      return [];
    }

    const rows = this.db
      .prepare(
        `SELECT id, ts_ms, phone_number, thread_id, turn_id, kind, summary, payload_json
         FROM audit_events
         WHERE phone_number = ? AND turn_id = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(phoneNumber, lastTurnRow.turn_id, limit) as unknown as AuditRow[];

    return rows.reverse().map((row) => ({
      id: row.id,
      tsMs: row.ts_ms,
      phoneNumber: row.phone_number,
      threadId: row.thread_id,
      turnId: row.turn_id,
      kind: row.kind,
      summary: row.summary,
      payload: safeJsonParse(row.payload_json),
    }));
  }

  appendNotification(event: NotificationEvent): { inserted: boolean; id: string; duplicateOf: string | null } {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO notifications(
           id, source, source_account, source_event_id, dedupe_key, status, received_at_ms, processed_at_ms,
           delivery, reason_code, message_excerpt, summary, payload_hash, raw_excerpt, raw_size_bytes, raw_truncated,
           duplicate_count, first_seen_at_ms, last_seen_at_ms, thread_id, turn_id, decision_json, error_text
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, NULL)`,
      )
      .run(
        event.id,
        event.source,
        event.sourceAccount,
        event.sourceEventId,
        event.dedupeKey,
        event.status,
        event.receivedAtMs,
        event.summary,
        event.payloadHash,
        event.rawExcerpt,
        event.rawSizeBytes,
        event.rawTruncated ? 1 : 0,
        event.firstSeenAtMs,
        event.lastSeenAtMs,
      );

    if (result.changes > 0) {
      return { inserted: true, id: event.id, duplicateOf: null };
    }

    const existing = this.db
      .prepare('SELECT id FROM notifications WHERE dedupe_key = ?')
      .get(event.dedupeKey) as { id: string } | undefined;

    if (!existing) {
      return { inserted: false, id: event.id, duplicateOf: null };
    }

    this.db
      .prepare('UPDATE notifications SET duplicate_count = duplicate_count + 1, last_seen_at_ms = ? WHERE id = ?')
      .run(nowMs(), existing.id);
    return { inserted: false, id: existing.id, duplicateOf: existing.id };
  }

  markNotificationQueued(id: string): void {
    this.db.prepare('UPDATE notifications SET status = ? WHERE id = ?').run('queued', id);
  }

  claimNextQueuedNotification(): NotificationRecord | null {
    const candidate = this.db
      .prepare(
        `SELECT id FROM notifications
         WHERE status IN ('received', 'queued')
         ORDER BY received_at_ms ASC, id ASC
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;

    if (!candidate) {
      return null;
    }

    const now = nowMs();
    const updated = this.db
      .prepare(
        `UPDATE notifications
         SET status = 'processing', processed_at_ms = ?
         WHERE id = ? AND status IN ('received', 'queued')`,
      )
      .run(now, candidate.id);
    if (updated.changes < 1) {
      return null;
    }

    return this.getNotificationById(candidate.id);
  }

  markNotificationProcessing(id: string, threadId: string | null, turnId: string | null): void {
    this.db
      .prepare(
        `UPDATE notifications
         SET status = 'processing', processed_at_ms = ?, thread_id = ?, turn_id = ?
         WHERE id = ?`,
      )
      .run(nowMs(), threadId, turnId, id);
  }

  recordNotificationDecision(args: {
    id: string;
    status: NotificationRecord['status'];
    decision: NotificationDecision;
    threadId?: string | null;
    turnId?: string | null;
  }): void {
    this.db
      .prepare(
        `UPDATE notifications
         SET status = ?, processed_at_ms = ?, delivery = ?, reason_code = ?, message_excerpt = ?, decision_json = ?,
             thread_id = COALESCE(?, thread_id), turn_id = COALESCE(?, turn_id), error_text = NULL
         WHERE id = ?`,
      )
      .run(
        args.status,
        nowMs(),
        args.decision.delivery,
        args.decision.reasonCode ?? null,
        clipText(args.decision.message ?? '', 1000) || null,
        JSON.stringify(args.decision),
        args.threadId ?? null,
        args.turnId ?? null,
        args.id,
      );
  }

  recordNotificationFailure(args: { id: string; errorText: string; threadId?: string | null; turnId?: string | null }): void {
    this.db
      .prepare(
        `UPDATE notifications
         SET status = 'failed', processed_at_ms = ?, error_text = ?,
             thread_id = COALESCE(?, thread_id), turn_id = COALESCE(?, turn_id)
         WHERE id = ?`,
      )
      .run(nowMs(), clipText(args.errorText, 4000), args.threadId ?? null, args.turnId ?? null, args.id);
  }

  listNotifications(query: NotificationListQuery): NotificationRecord[] {
    const count = clampLimit(query.count, 1, 200);
    if (!query.source || query.source === 'all') {
      const rows = this.db
        .prepare(
          `SELECT *
           FROM notifications
           ORDER BY received_at_ms DESC
           LIMIT ?`,
        )
        .all(count) as unknown as NotificationRow[];
      return rows.map(parseNotificationRow);
    }

    const rows = this.db
      .prepare(
        `SELECT *
         FROM notifications
         WHERE source = ?
         ORDER BY received_at_ms DESC
         LIMIT ?`,
      )
      .all(query.source, count) as unknown as NotificationRow[];
    return rows.map(parseNotificationRow);
  }

  getNotificationById(id: string): NotificationRecord | null {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow | undefined;
    return row ? parseNotificationRow(row) : null;
  }

  queryNotifications(query: NotificationSearchQuery): NotificationRecord[] {
    const limit = clampLimit(query.limit, 1, 200);
    const where: string[] = [];
    const args: Array<string | number> = [];

    if (query.source && query.source !== 'all') {
      where.push('source = ?');
      args.push(query.source);
    }
    if (query.status) {
      where.push('status = ?');
      args.push(query.status);
    }
    if (query.sinceMs !== undefined) {
      where.push('received_at_ms >= ?');
      args.push(Math.floor(query.sinceMs));
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `SELECT * FROM notifications ${whereClause} ORDER BY received_at_ms DESC LIMIT ?`;
    args.push(limit);

    const rows = this.db.prepare(sql).all(...args) as unknown as NotificationRow[];
    return rows.map(parseNotificationRow);
  }

  pruneNotifications(currentTimeMs: number, retentionDays: number, maxRows: number): number {
    const windowMs = Math.max(1, Math.floor(retentionDays)) * 24 * 60 * 60 * 1000;
    const thresholdMs = currentTimeMs - windowMs;
    let pruned = 0;

    const deleteByWindow = this.db.prepare('DELETE FROM notifications WHERE received_at_ms < ?').run(thresholdMs);
    pruned += Number(deleteByWindow.changes);

    const countRow = this.db.prepare('SELECT COUNT(*) AS total FROM notifications').get() as { total: number } | undefined;
    const totalRows = countRow?.total ?? 0;
    const cap = Math.max(1, Math.floor(maxRows));
    if (totalRows <= cap) {
      return pruned;
    }

    const overflow = totalRows - cap;
    const idsToDelete = this.db
      .prepare(
        `SELECT id FROM notifications
         ORDER BY received_at_ms ASC, id ASC
         LIMIT ?`,
      )
      .all(overflow) as Array<{ id: string }>;

    const deleteStmt = this.db.prepare('DELETE FROM notifications WHERE id = ?');
    for (const row of idsToDelete) {
      const result = deleteStmt.run(row.id);
      pruned += Number(result.changes);
    }

    return pruned;
  }
}

function parsePendingBridgeRestartNotice(raw: string): PendingBridgeRestartNotice | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PendingBridgeRestartNotice>;
    if (
      parsed &&
      (parsed.target === 'bridge' || parsed.target === 'both') &&
      typeof parsed.requestedAtMs === 'number' &&
      Number.isFinite(parsed.requestedAtMs)
    ) {
      return {
        target: parsed.target,
        requestedAtMs: parsed.requestedAtMs,
      };
    }
  } catch {
    // ignore malformed payloads
  }
  return null;
}

function parseSparkReturnTarget(raw: string): SparkReturnTarget | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SparkReturnTarget>;
    if (parsed && typeof parsed.model === 'string' && typeof parsed.effort === 'string') {
      if (REASONING_EFFORT_LEVELS.includes(parsed.effort as ReasoningEffort)) {
        return {
          model: parsed.model,
          effort: parsed.effort as ReasoningEffort,
        };
      }
    }
  } catch {
    // ignore malformed payloads
  }
  return null;
}

function defaultReasoningEffortForModel(model: string): ReasoningEffort {
  return model.toLowerCase().includes('spark') ? 'xhigh' : 'medium';
}

function parseNotificationRow(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    source: row.source as NotificationRecord['source'],
    sourceAccount: row.source_account,
    sourceEventId: row.source_event_id,
    dedupeKey: row.dedupe_key,
    status: row.status as NotificationRecord['status'],
    receivedAtMs: row.received_at_ms,
    processedAtMs: row.processed_at_ms,
    delivery: (row.delivery as NotificationRecord['delivery']) ?? null,
    reasonCode: row.reason_code,
    messageExcerpt: row.message_excerpt,
    summary: row.summary,
    payloadHash: row.payload_hash,
    rawExcerpt: row.raw_excerpt,
    rawSizeBytes: row.raw_size_bytes,
    rawTruncated: row.raw_truncated === 1,
    duplicateCount: row.duplicate_count,
    firstSeenAtMs: row.first_seen_at_ms,
    lastSeenAtMs: row.last_seen_at_ms,
    threadId: row.thread_id,
    turnId: row.turn_id,
    decision: row.decision_json ? (safeJsonParse(row.decision_json) as NotificationDecision) : null,
    errorText: row.error_text,
  };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function clipText(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function clampLimit(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

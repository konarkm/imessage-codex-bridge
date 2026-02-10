import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent, AuditKind, BridgeFlags, SessionState } from '../types.js';
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

export class StateStore {
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
    this.db
      .prepare('UPDATE sessions SET thread_id = ?, updated_at_ms = ? WHERE phone_number = ?')
      .run(threadId, now, phoneNumber);
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
    this.db
      .prepare('UPDATE sessions SET model = ?, updated_at_ms = ? WHERE phone_number = ?')
      .run(model, now, phoneNumber);
  }

  resetRuntime(phoneNumber: string): void {
    this.ensureSession(phoneNumber);
    const now = nowMs();
    this.db
      .prepare(
        'UPDATE sessions SET thread_id = NULL, active_turn_id = NULL, updated_at_ms = ? WHERE phone_number = ?',
      )
      .run(now, phoneNumber);
  }

  isMessageProcessed(messageHandle: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM inbound_messages WHERE message_handle = ?')
      .get(messageHandle) as { 1: number } | undefined;
    return row !== undefined;
  }

  hasProcessedMessages(): boolean {
    const row = this.db
      .prepare('SELECT 1 AS present FROM inbound_messages LIMIT 1')
      .get() as { present: number } | undefined;
    return row !== undefined;
  }

  markMessageProcessed(messageHandle: string): boolean {
    const now = nowMs();
    const result = this.db
      .prepare('INSERT OR IGNORE INTO inbound_messages(message_handle, received_at_ms) VALUES (?, ?)')
      .run(messageHandle, now);
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
      .run(
        nowMs(),
        entry.phoneNumber ?? null,
        entry.threadId ?? null,
        entry.turnId ?? null,
        entry.kind,
        entry.summary,
        payloadJson,
      );
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
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

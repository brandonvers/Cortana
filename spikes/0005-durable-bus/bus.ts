/**
 * A minimal durable message bus, in the shape the kernel will use.
 *
 * Throwaway, but deliberately not a toy: the point of the spike is to kill a
 * real process in the middle of a real write to a real file, so the write path
 * has to be the real one. WAL, a single writer, an explicit transaction per
 * message, and an idempotency table.
 */

import Database from 'better-sqlite3';

export type MessageKind = 'report' | 'blocker' | 'task';

export type Message = {
  id: string;
  requestId: string;
  sender: string;
  recipient: string;
  kind: MessageKind;
  payload: unknown;
};

export type StoredMessage = Message & {
  createdAt: number;
  attempts: number;
  state: 'pending' | 'leased' | 'delivered';
};

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = FULL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  request_id   TEXT NOT NULL,
  sender       TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  lease_until  INTEGER,
  lease_owner  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS messages_request ON messages(request_id);
CREATE INDEX IF NOT EXISTS messages_state ON messages(state);

CREATE TABLE IF NOT EXISTS requests (
  id           TEXT PRIMARY KEY,
  expected     INTEGER NOT NULL,
  deadline_at  INTEGER NOT NULL
);

-- Idempotency. A message may be redelivered after a crash; it may only be
-- ACTED ON once. This table is the record of what has already had effect.
CREATE TABLE IF NOT EXISTS effects (
  message_id   TEXT PRIMARY KEY,
  applied_at   INTEGER NOT NULL
);
`;

/**
 * `synchronous = FULL` rather than NORMAL. NORMAL is the right production
 * setting for most workloads, but this spike is specifically asking whether an
 * acknowledged write survives the process disappearing, and NORMAL permits the
 * OS to still be holding it. Testing durability against a setting that trades
 * durability away would answer a different question.
 */
export class Bus {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec(SCHEMA);
  }

  /**
   * Writes one message and does not return until it is on disk. The caller may
   * treat a return from this function as an acknowledgement — which is exactly
   * the claim the spike attacks.
   */
  send(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, request_id, sender, recipient, kind, payload_json, created_at)
         VALUES (@id, @requestId, @sender, @recipient, @kind, @payload, @createdAt)`,
      )
      .run({
        id: m.id,
        requestId: m.requestId,
        sender: m.sender,
        recipient: m.recipient,
        kind: m.kind,
        payload: JSON.stringify(m.payload),
        createdAt: Date.now(),
      });
  }

  openRequest(id: string, expected: number, deadlineMs: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO requests (id, expected, deadline_at) VALUES (?, ?, ?)')
      .run(id, expected, Date.now() + deadlineMs);
  }

  /** Takes a lease. A lease that outlives its owner is reclaimed by `reclaim`. */
  lease(recipient: string, owner: string, ttlMs: number): StoredMessage[] {
    const now = Date.now();
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
          WHERE recipient = ? AND state = 'pending'
          ORDER BY created_at`,
      )
      .all(recipient) as Array<Record<string, unknown>>;

    const taken = this.db.transaction((list: Array<Record<string, unknown>>) => {
      const stmt = this.db.prepare(
        `UPDATE messages SET state='leased', lease_until=?, lease_owner=?, attempts=attempts+1
          WHERE id=? AND state='pending'`,
      );
      for (const r of list) stmt.run(now + ttlMs, owner, r['id']);
    });
    taken(rows);

    return rows.map((r) => this.#hydrate(r));
  }

  /** Reclaims leases whose owner died. Called at boot. */
  reclaim(): number {
    const info = this.db
      .prepare(
        `UPDATE messages SET state='pending', lease_until=NULL, lease_owner=NULL
          WHERE state='leased' AND lease_until < ?`,
      )
      .run(Date.now());
    return info.changes;
  }

  /**
   * Applies a message's effect exactly once, even if it is redelivered.
   * Returns false when the effect had already been applied.
   */
  applyOnce(messageId: string, effect: () => void): boolean {
    const tx = this.db.transaction(() => {
      const already = this.db.prepare('SELECT 1 FROM effects WHERE message_id = ?').get(messageId);
      if (already) return false;
      effect();
      this.db
        .prepare('INSERT INTO effects (message_id, applied_at) VALUES (?, ?)')
        .run(messageId, Date.now());
      this.db.prepare(`UPDATE messages SET state='delivered' WHERE id = ?`).run(messageId);
      return true;
    });
    return tx() as boolean;
  }

  /**
   * The delivery rule from ADR-0014, in three lines rather than three
   * paragraphs.
   *
   * A blocker goes now. Otherwise a request's reports wait until all of them
   * have arrived, so the main agent synthesises one answer from the whole
   * picture. A deadline bounds that wait so one stalled sibling cannot withhold
   * what the others already finished.
   */
  readyFor(requestId: string): { deliver: StoredMessage[]; reason: string; missing: number } {
    const req = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId) as
      | { expected: number; deadline_at: number }
      | undefined;

    const pending = (
      this.db
        .prepare(
          `SELECT * FROM messages WHERE request_id = ? AND state != 'delivered' ORDER BY created_at`,
        )
        .all(requestId) as Array<Record<string, unknown>>
    ).map((r) => this.#hydrate(r));

    const blockers = pending.filter((m) => m.kind === 'blocker');
    if (blockers.length > 0) {
      return { deliver: blockers, reason: 'blocker — delivered immediately', missing: 0 };
    }

    const expected = req?.expected ?? pending.length;
    const reports = pending.filter((m) => m.kind === 'report');

    if (reports.length >= expected) {
      return { deliver: reports, reason: 'request complete — delivered together', missing: 0 };
    }
    if (req && Date.now() > req.deadline_at) {
      return {
        deliver: reports,
        reason: 'deadline passed — partial delivery',
        missing: expected - reports.length,
      };
    }
    return { deliver: [], reason: 'holding for siblings', missing: expected - reports.length };
  }

  #hydrate(r: Record<string, unknown>): StoredMessage {
    return {
      id: String(r['id']),
      requestId: String(r['request_id']),
      sender: String(r['sender']),
      recipient: String(r['recipient']),
      kind: String(r['kind']) as MessageKind,
      payload: JSON.parse(String(r['payload_json'])),
      createdAt: Number(r['created_at']),
      attempts: Number(r['attempts']),
      state: String(r['state']) as StoredMessage['state'],
    };
  }

  close(): void {
    this.db.close();
  }
}

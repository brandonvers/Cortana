/**
 * Forgetting, on purpose and on a schedule.
 *
 * [ADR-0019](../../../docs/adr/0019-the-audit-stores-what-was-said.md) made
 * retention a number rather than "forever", and the reasoning is the part worth
 * keeping: unbounded retention is not a decision to keep everything, it is a
 * decision to defer deletion to the day the disk fills — when it will be made in
 * a hurry and probably with `rm`.
 *
 * So expiry is ordinary work through the writer, in the same transaction
 * discipline as everything else, rather than an operational afterthought.
 */

import { type Clock, type Logger, systemClock } from '@cortana/core';
import type { Writer } from '@cortana/storage';
import { lt } from 'drizzle-orm';
import { auditTurns } from './schema.ts';

/**
 * The default window.
 *
 * Long enough to investigate something that happened last quarter, short enough
 * that a home server's disk is not the thing that eventually decides.
 */
export const DEFAULT_RETENTION_DAYS = 90;

export interface ExpiryOptions {
  readonly writer: Writer;
  readonly retentionDays?: number;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export interface ExpiryReport {
  readonly removed: number;
  /** Everything recorded before this instant is gone. */
  readonly olderThan: Date;
}

/**
 * Deletes audit rows older than the retention window.
 *
 * A retention of zero or less deletes nothing and says so, rather than being
 * read as "keep nothing" — the difference between an unset value and an
 * instruction to erase the record is not one to infer from a number.
 */
export async function expireAudit(options: ExpiryOptions): Promise<ExpiryReport> {
  const clock = options.clock ?? systemClock;
  const days = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const olderThan = new Date(clock.now() - days * 86_400_000);

  if (!Number.isFinite(days) || days <= 0) {
    options.logger?.warn('audit retention is not a positive number of days; keeping everything', {
      retentionDays: days,
    });
    return { removed: 0, olderThan };
  }

  const removed = await options.writer.write('expire audit rows', ({ db }) => {
    const result = db.delete(auditTurns).where(lt(auditTurns.startedAt, olderThan.getTime())).run();
    return result.changes;
  });

  if (removed > 0) {
    options.logger?.info('expired audit rows', { removed, olderThan: olderThan.toISOString() });
  }
  return { removed, olderThan };
}

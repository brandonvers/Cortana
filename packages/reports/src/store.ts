/**
 * Reports, stored before they are acknowledged and completed once.
 *
 * [ADR-0014](../../../docs/adr/0014-kernel-mediated-reports.md): "the kernel
 * receives reports, not the main agent. Every report is written to durable
 * storage the moment it arrives, before anything acknowledges it." This is that
 * store. When a report is *delivered* — which ones, and together with which
 * siblings — is the next step's business; this one makes sure that whatever is
 * decided, nothing acknowledged is lost and nothing is completed twice.
 *
 * ## What was promoted from spike 0005, and what was not
 *
 * [Spike 0005](../../../docs/spikes/0005-durable-bus.md) measured the mechanism
 * and its harness is the reference. Four things in that harness were not
 * carried over, because each is correct for a script that runs once and wrong
 * for a daemon:
 *
 * 1. **Its lease read the pending rows outside the transaction and returned all
 *    of them**, including rows whose update changed nothing because something
 *    else had taken them in between. Two callers would each be handed the same
 *    report. Here the read and the update are one write unit, and only rows that
 *    actually changed are returned.
 * 2. **Its reclaim only took back expired leases.** At boot every lease belongs
 *    to a process that no longer exists — the previous run of this one — so
 *    waiting out its TTL only delays work that is already known to be stranded.
 *    Leases carry the instance that took them, and boot reclaims every one that
 *    is not this instance's.
 * 3. **Its `applyOnce` ran the effect inside the SQLite transaction.** That is
 *    exactly-once only for an effect that is itself a write in the same
 *    transaction, and delivering a report is not: it is a model turn, which
 *    cannot be rolled back and cannot even be awaited inside a better-sqlite3
 *    transaction. See the guarantee below.
 * 4. **It used `Date.now()` and `INSERT OR REPLACE`.** The first makes a deadline
 *    untestable; the second let reopening a request silently reset its deadline.
 *
 * ## The guarantee, stated exactly
 *
 * **At-least-once delivery, exactly-once completion.**
 *
 * A report is leased, handed to whoever delivers it, and then completed. If the
 * process dies after handing it over and before completing it, the lease is
 * reclaimed at boot and the report is delivered again. That is not a defect this
 * store could fix: the far side of a delivery is a model turn, and no amount of
 * bookkeeping here can make an external effect un-happen. What this store does
 * guarantee is that completion is recorded once — a second `complete` on the
 * same report changes nothing and says so — and that nothing acknowledged is
 * ever stranded in a lease nobody holds.
 *
 * So a consumer must tolerate seeing a report twice. Reports carry their ids so
 * that a repeat is recognisable, which is the consumer's half of the bargain and
 * the only half that can be kept.
 */

import { AppError, type Clock, type InstanceId, systemClock, uuidV7 } from '@cortana/core';
import type { Storage, Writer } from '@cortana/storage';
import { and, asc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import { decideDelivery } from './aggregate.ts';
import { type ReportRow, reports, requestAssignments, requests } from './schema.ts';

/**
 * The most a single report's payload may be.
 *
 * A report is a model's summary of work it did, and a quarter of a megabyte of
 * that is already far past anything a person or a main agent would read. The
 * limit is here because the payload is model output: without one, a runaway
 * turn decides how large the database gets.
 */
export const MAX_PAYLOAD_BYTES = 262_144;

export type ReportKind = ReportRow['kind'];
export type ReportState = ReportRow['state'];

export interface NewReport {
  /** Minted by the sender, so a retried submission is recognisable. */
  readonly id: string;
  readonly requestId: string;
  readonly sender: string;
  readonly kind: ReportKind;
  readonly payload: unknown;
}

export interface StoredReport {
  readonly id: string;
  readonly requestId: string;
  readonly sender: string;
  readonly kind: ReportKind;
  readonly payload: unknown;
  readonly state: ReportState;
  readonly attempts: number;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

export interface OpenRequest {
  /**
   * Who the work was given to, by roster name. At least one, and each once.
   *
   * Names rather than a count, because a count cannot tell two reports from one
   * agent apart from one report each from two — see `requestAssignments`.
   */
  readonly assignees: readonly string[];
  /** How long to hold for siblings before delivering what is there. */
  readonly deadlineMs: number;
}

export interface RequestRecord {
  readonly id: string;
  readonly assignees: readonly string[];
  readonly deadlineAt: number;
  readonly createdAt: number;
  /** When the deadline notice went out, or null if it has not. */
  readonly timedOutAt: number | null;
  readonly closedAt: number | null;
}

export interface Settled {
  /** Reports this call marked delivered. */
  readonly completed: number;
  /** Whether this call found the request finished and closed it. */
  readonly closed: boolean;
}

export interface ReportStore {
  openRequest(request: OpenRequest): Promise<string>;
  /**
   * Stores a report, and resolves only once it is on disk.
   *
   * `accepted: false` is a submission this store already has — the retry of a
   * sender that crashed without learning its first attempt had landed. It is an
   * ordinary answer, not an error.
   */
  submit(report: NewReport): Promise<{ readonly accepted: boolean }>;
  /** Reports for a request that nobody has completed yet, oldest first. */
  outstanding(requestId: string): readonly StoredReport[];
  /** Every report for a request, whatever its state, oldest first. */
  reportsFor(requestId: string): readonly StoredReport[];
  request(requestId: string): RequestRecord | null;
  /** Requests still waiting on something, oldest first. */
  openRequests(): readonly string[];
  /** Marks a request finished. A second call changes nothing and returns false. */
  close(requestId: string): Promise<boolean>;
  /**
   * Records that a delivery reached the main agent, in one transaction: the
   * reports completed, the deadline notice marked sent if that is what it was,
   * and the request closed if nothing is left to wait for.
   *
   * One unit because each of those facts depends on the others. Completing the
   * reports and then crashing before marking the notice would send the notice
   * again; closing on a separate write could close a request a report arrived
   * for in between.
   *
   * The deadline notice is marked only if every report in it was completed by
   * this run. A lease lost to a restart means the notice was not this run's to
   * deliver, and whoever holds it now will send it.
   */
  settle(
    requestId: string,
    reportIds: readonly string[],
    options: { readonly deadlineNotice: boolean },
  ): Promise<Settled>;
  get(id: string): StoredReport | null;
  /**
   * Takes a lease on these reports for this instance, and returns the ones it
   * actually took.
   *
   * A report already leased or delivered is not in the result. The caller
   * delivers exactly what comes back, which is the difference from the spike.
   */
  lease(ids: readonly string[], ttlMs: number): Promise<readonly StoredReport[]>;
  /** Marks leased reports delivered. Returns how many changed; a repeat changes none. */
  complete(ids: readonly string[]): Promise<number>;
  /** Gives leases back, so the reports are delivered again. For a delivery that failed. */
  release(ids: readonly string[]): Promise<number>;
  /** Returns every lease not held by this instance. Called once, at boot. */
  reclaimAtBoot(): Promise<number>;
  /** Returns leases whose time ran out, whoever held them. */
  reclaimExpired(): Promise<number>;
}

export interface ReportStoreOptions {
  readonly storage: Storage;
  readonly writer: Writer;
  /** This run of the daemon. A lease records it, so a restart knows whose leases died. */
  readonly instanceId: InstanceId;
  readonly clock?: Clock;
}

const contract = (message: string, code: string, detail: Record<string, string | number>) =>
  new AppError(message, { category: 'contract', code, detail });

function hydrate(row: ReportRow): StoredReport {
  return {
    id: row.id,
    requestId: row.requestId,
    sender: row.sender,
    kind: row.kind,
    payload: JSON.parse(row.payload) as unknown,
    state: row.state,
    attempts: row.attempts,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  };
}

type Db = Storage['db'];

function readRequest(db: Db, requestId: string): RequestRecord | null {
  const row = db.select().from(requests).where(eq(requests.id, requestId)).get();
  if (row === undefined) return null;
  const assignees = db
    .select()
    .from(requestAssignments)
    .where(eq(requestAssignments.requestId, requestId))
    .all()
    .map((assignment) => assignment.assignee)
    .sort();
  return {
    id: row.id,
    assignees,
    deadlineAt: row.deadlineAt,
    createdAt: row.createdAt,
    timedOutAt: row.timedOutAt,
    closedAt: row.closedAt,
  };
}

function readReports(db: Db, requestId: string): StoredReport[] {
  return db
    .select()
    .from(reports)
    .where(eq(reports.requestId, requestId))
    .orderBy(asc(reports.createdAt), asc(reports.id))
    .all()
    .map(hydrate);
}

export function createReportStore(options: ReportStoreOptions): ReportStore {
  const clock = options.clock ?? systemClock;
  const { storage, writer } = options;
  const owner = options.instanceId as string;

  /**
   * Marks leased reports delivered, inside whatever unit calls it.
   *
   * Only a lease this instance holds. A lease that was reclaimed and taken by
   * someone else is no longer ours to complete, and completing it anyway would
   * mark delivered a report its current holder has not delivered yet.
   */
  const completeIn = (db: Db, ids: readonly string[], now: number): number =>
    ids.length === 0
      ? 0
      : db
          .update(reports)
          .set({ state: 'delivered', deliveredAt: now, leaseOwner: null, leaseUntil: null })
          .where(
            and(
              inArray(reports.id, [...ids]),
              eq(reports.state, 'leased'),
              eq(reports.leaseOwner, owner),
            ),
          )
          .run().changes;

  return {
    async openRequest(request) {
      if (request.assignees.length === 0) {
        throw contract(
          'a request has to be given to at least one agent',
          'request-expects-nothing',
          { assignees: 0 },
        );
      }
      if (request.assignees.some((name) => typeof name !== 'string' || name.trim() === '')) {
        throw contract('a request was given to an agent with no name', 'request-unnamed-assignee', {
          assignees: request.assignees.length,
        });
      }
      if (new Set(request.assignees).size !== request.assignees.length) {
        // Not deduplicated quietly. Giving the same agent the same request twice
        // is a delegation that went wrong upstream, and the place to hear about
        // it is here rather than in a report count that never adds up.
        throw contract(
          'a request was given to the same agent more than once',
          'request-duplicate-assignee',
          { assignees: request.assignees.length },
        );
      }
      if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) {
        throw contract('a request needs a deadline in the future', 'request-without-deadline', {
          deadlineMs: request.deadlineMs,
        });
      }

      const now = clock.now();
      const id = uuidV7(now) as string;
      // A plain insert. The spike's INSERT OR REPLACE let reopening a request
      // reset its deadline without a word, and ids are minted here, so a
      // collision is a defect worth hearing about rather than a case to absorb.
      // One unit, so a request never exists without the list of who it went to —
      // a request with no assignments would read as finished the moment it was
      // opened.
      await writer.write('open a request', ({ db }) => {
        db.insert(requests)
          .values({ id, deadlineAt: now + request.deadlineMs, createdAt: now })
          .run();
        db.insert(requestAssignments)
          .values(request.assignees.map((assignee) => ({ requestId: id, assignee })))
          .run();
      });
      return id;
    },

    async submit(report) {
      let payload: string;
      try {
        payload = JSON.stringify(report.payload);
      } catch (error) {
        throw contract('a report payload must be expressible as JSON', 'report-not-json', {
          id: report.id,
          reason: String(error),
        });
      }
      if (payload === undefined) {
        throw contract('a report must carry a payload', 'report-without-payload', {
          id: report.id,
        });
      }
      const bytes = Buffer.byteLength(payload, 'utf8');
      if (bytes > MAX_PAYLOAD_BYTES) {
        throw contract(
          `a report payload is ${bytes} bytes and the limit is ${MAX_PAYLOAD_BYTES}`,
          'report-too-large',
          { id: report.id, bytes, limit: MAX_PAYLOAD_BYTES },
        );
      }

      return writer.write('submit a report', ({ db }) => {
        // Inside the unit, so a request cannot be checked and then vanish
        // before the report referring to it is written.
        const request = db.select().from(requests).where(eq(requests.id, report.requestId)).get();
        if (request === undefined) {
          throw contract(
            'a report arrived for a request that does not exist',
            'report-for-unknown-request',
            { id: report.id, requestId: report.requestId },
          );
        }

        // A retry is still a retry after the request closed. Checked before
        // either refusal below, so a sender that crashed without learning its
        // report landed is told what happened rather than that it did wrong.
        //
        // This makes the conflict clause on the insert below look redundant, and
        // in this process it is: a duplicate returns here first. Measured, as
        // with the lease — either guard alone keeps a retry from rewriting a
        // report, and the test fails only when both are gone. The clause stays
        // for a writer this check cannot see, and removing either on the grounds
        // that the other exists is how the protection quietly becomes one.
        const existing = db.select().from(reports).where(eq(reports.id, report.id)).get();
        if (existing !== undefined) return { accepted: false };

        if (request.closedAt !== null) {
          throw contract(
            'a report arrived for a request that has already finished',
            'report-for-closed-request',
            { id: report.id, requestId: report.requestId },
          );
        }

        // An agent reporting on work it was not given. Refused rather than
        // stored: nothing an agent says about itself decides what it was asked
        // to do — CONCEPTS §7.3 — and a report from outside the assignment would
        // otherwise reach the main agent as though it had been.
        const assigned = db
          .select()
          .from(requestAssignments)
          .where(
            and(
              eq(requestAssignments.requestId, report.requestId),
              eq(requestAssignments.assignee, report.sender),
            ),
          )
          .get();
        if (assigned === undefined) {
          throw contract(
            `"${report.sender}" reported on a request it was not given`,
            'report-from-unassigned-sender',
            { id: report.id, requestId: report.requestId, sender: report.sender },
          );
        }

        const result = db
          .insert(reports)
          .values({
            id: report.id,
            requestId: report.requestId,
            sender: report.sender,
            kind: report.kind,
            payload,
            state: 'pending',
            createdAt: clock.now(),
          })
          .onConflictDoNothing({ target: reports.id })
          .run();
        return { accepted: result.changes === 1 };
      });
    },

    reportsFor: (requestId) => readReports(storage.db, requestId),

    request: (requestId) => readRequest(storage.db, requestId),

    openRequests() {
      return storage.db
        .select({ id: requests.id })
        .from(requests)
        .where(isNull(requests.closedAt))
        .orderBy(asc(requests.createdAt), asc(requests.id))
        .all()
        .map((row) => row.id);
    },

    async close(requestId) {
      return writer.write(
        'close a request',
        ({ db }) =>
          db
            .update(requests)
            .set({ closedAt: clock.now() })
            .where(and(eq(requests.id, requestId), isNull(requests.closedAt)))
            .run().changes === 1,
      );
    },

    async settle(requestId, reportIds, settleOptions) {
      return writer.write('settle a delivery', ({ db }) => {
        const now = clock.now();
        const completed = completeIn(db, reportIds, now);

        if (settleOptions.deadlineNotice && completed === reportIds.length) {
          db.update(requests)
            .set({ timedOutAt: now })
            .where(and(eq(requests.id, requestId), isNull(requests.timedOutAt)))
            .run();
        }

        // Read back inside the unit and asked of the same rule that decides
        // deliveries, so "finished" cannot mean one thing here and another
        // there — and nothing can arrive between the read and the close.
        const record = readRequest(db, requestId);
        if (record === null) return { completed, closed: false };
        const decision = decideDelivery({
          request: record,
          reports: readReports(db, requestId),
          now,
        });
        const closed =
          decision.action === 'finished' &&
          db
            .update(requests)
            .set({ closedAt: now })
            .where(and(eq(requests.id, requestId), isNull(requests.closedAt)))
            .run().changes === 1;
        return { completed, closed };
      });
    },

    outstanding(requestId) {
      return storage.db
        .select()
        .from(reports)
        .where(and(eq(reports.requestId, requestId), ne(reports.state, 'delivered')))
        .orderBy(asc(reports.createdAt), asc(reports.id))
        .all()
        .map(hydrate);
    },

    get(id) {
      const row = storage.db.select().from(reports).where(eq(reports.id, id)).get();
      return row === undefined ? null : hydrate(row);
    },

    async lease(ids, ttlMs) {
      if (ids.length === 0) return [];
      return writer.write('lease reports', ({ db }) => {
        const now = clock.now();
        // Two guards against spike 0005's lease handing one report to two
        // callers, and **either alone is sufficient** — measured, not assumed:
        //
        //   guard removed, read inside this unit      survives the test
        //   read moved before the unit, guard kept    survives the test
        //   both — the spike's code exactly           fails it
        //
        // The read being inside the unit means nothing else runs between it and
        // the update. The `changed === 1` check below means that even if it did,
        // a row someone else took would not be returned. One looks redundant
        // next to the other, and removing either on those grounds is how the
        // spike's bug comes back the day somebody moves the read.
        const taken: ReportRow[] = [];
        for (const row of db
          .select()
          .from(reports)
          .where(and(inArray(reports.id, [...ids]), eq(reports.state, 'pending')))
          .orderBy(asc(reports.createdAt), asc(reports.id))
          .all()) {
          const changed = db
            .update(reports)
            .set({
              state: 'leased',
              leaseOwner: owner,
              leaseUntil: now + ttlMs,
              attempts: row.attempts + 1,
            })
            .where(and(eq(reports.id, row.id), eq(reports.state, 'pending')))
            .run().changes;
          if (changed === 1) {
            taken.push({
              ...row,
              state: 'leased',
              leaseOwner: owner,
              leaseUntil: now + ttlMs,
              attempts: row.attempts + 1,
            });
          }
        }
        return taken.map(hydrate);
      });
    },

    async complete(ids) {
      if (ids.length === 0) return 0;
      // The same statement `settle` uses, so there is one definition of what
      // completing a report means.
      return writer.write('complete reports', ({ db }) => completeIn(db, ids, clock.now()));
    },

    async release(ids) {
      if (ids.length === 0) return 0;
      return writer.write(
        'release reports',
        ({ db }) =>
          db
            .update(reports)
            .set({ state: 'pending', leaseOwner: null, leaseUntil: null })
            .where(
              and(
                inArray(reports.id, [...ids]),
                eq(reports.state, 'leased'),
                eq(reports.leaseOwner, owner),
              ),
            )
            .run().changes,
      );
    },

    async reclaimAtBoot() {
      return writer.write(
        'reclaim leases from a previous run',
        ({ db }) =>
          db
            .update(reports)
            .set({ state: 'pending', leaseOwner: null, leaseUntil: null })
            // `or isNull` is not decoration. In SQL `lease_owner != 'x'` is NULL,
            // not true, when the owner is NULL — so a leased row with no owner,
            // from an older build or a write interrupted halfway, would match
            // neither this nor anything else and stay leased forever.
            .where(
              and(
                eq(reports.state, 'leased'),
                or(ne(reports.leaseOwner, owner), isNull(reports.leaseOwner)),
              ),
            )
            .run().changes,
      );
    },

    async reclaimExpired() {
      return writer.write(
        'reclaim expired leases',
        ({ db }) =>
          db
            .update(reports)
            .set({ state: 'pending', leaseOwner: null, leaseUntil: null })
            // The same NULL rule: a lease with no expiry has not "not expired",
            // it is a lease nothing will ever end.
            .where(
              and(
                eq(reports.state, 'leased'),
                or(lt(reports.leaseUntil, clock.now()), isNull(reports.leaseUntil)),
              ),
            )
            .run().changes,
      );
    },
  };
}

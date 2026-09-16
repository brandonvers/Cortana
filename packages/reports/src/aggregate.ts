/**
 * When a request's reports reach the main agent, and what it is told about the
 * ones that did not arrive.
 *
 * [ADR-0014](../../../docs/adr/0014-kernel-mediated-reports.md), in the order it
 * gives them:
 *
 * 1. **A blocker or a decision request is delivered immediately.**
 * 2. **Otherwise reports are held until the request's outstanding work is
 *    done**, then the whole set is delivered in one turn.
 * 3. **A per-request timeout bounds the hold**; the main agent then receives what
 *    is ready "and is told explicitly what is missing and why".
 *
 * The ADR calls this "a correctness-critical path. A bug here silently loses
 * work", and the milestone plan adds that it is the least visible code when it
 * is wrong. So the decision is a pure function of the request, its reports and
 * the time — no database, no clock, no lease — and every case below is a test
 * rather than a hope.
 *
 * ## What spike 0005's rule got wrong, and what it never had to decide
 *
 * The spike's `readyFor` behaved as specified on the scenarios it was given, and
 * gave the wrong answer on four it was not:
 *
 * - **It counted reports instead of naming who sent them.** An agent that
 *   reported twice filled the count while another team said nothing, and the
 *   request went out as complete with a team missing.
 * - **It offered reports that were already being delivered**, because "not yet
 *   delivered" included a lease in flight.
 * - **It measured what was missing against undelivered reports only**, so after
 *   a partial delivery at the deadline, a late arrival was reported with the
 *   already-delivered reports counted as missing.
 * - **It had no decision requests**, though the first rule names them.
 *
 * And one case neither the spike nor the ADR's wording covered: **every team
 * stalls.** At the deadline there is nothing ready, a rule that delivers "what is
 * ready" delivers nothing, and the person who asked is never answered. Here the
 * deadline notice goes out even when it is empty, naming everyone.
 */

import { AppError, type Clock, systemClock } from '@cortana/core';
import type { ReportStore, RequestRecord, Settled, StoredReport } from './store.ts';

/**
 * Why a set of reports is going out now.
 *
 * - `urgent` — a blocker or a decision request, rule 1.
 * - `complete` — every assignee has reported, rule 2.
 * - `deadline` — the hold ran out, rule 3. May carry no reports at all.
 * - `late` — anything arriving after the main agent already had the picture:
 *   after the complete set went out, or after the deadline notice did.
 */
export type DeliveryReason = 'urgent' | 'complete' | 'deadline' | 'late';

export interface Missing {
  readonly assignee: string;
  /** In words the main agent can pass on, because the ADR requires the why. */
  readonly why: string;
}

export type DeliveryDecision =
  | {
      readonly action: 'deliver';
      readonly reason: DeliveryReason;
      readonly reports: readonly StoredReport[];
      readonly missing: readonly Missing[];
    }
  /** Rule 2: siblings are still working and the deadline has not come. */
  | { readonly action: 'hold'; readonly waitingFor: readonly string[]; readonly deadlineAt: number }
  /** Nothing to do yet, for a reason that is not the hold. */
  | { readonly action: 'wait'; readonly why: string }
  /** Everyone reported and everything was delivered. The request can close. */
  | { readonly action: 'finished' }
  | { readonly action: 'closed' };

export interface DeliveryInput {
  readonly request: RequestRecord;
  /** Every report for the request, in every state. */
  readonly reports: readonly StoredReport[];
  readonly now: number;
}

const NO_REPORT = 'no report before the deadline';

/**
 * What should happen to one request, now.
 *
 * The order of the checks is the order of the rules, and it matters: an urgent
 * report goes out even while an ordinary delivery for the same request is in
 * flight, because a team that is stuck does not wait for anybody.
 */
export function decideDelivery({ request, reports, now }: DeliveryInput): DeliveryDecision {
  if (request.closedAt !== null) return { action: 'closed' };

  const pending = reports.filter((report) => report.state === 'pending');

  // Rule 1. Only the urgent ones: the rest keep holding for their siblings.
  const urgent = pending.filter((report) => report.kind !== 'report');
  if (urgent.length > 0) {
    return { action: 'deliver', reason: 'urgent', reports: urgent, missing: [] };
  }

  // A delivery already out and not yet settled. Offering its reports again is
  // the spike's second defect; offering *anything* else for the request now
  // would split one answer across two turns for no reason but timing.
  if (reports.some((report) => report.state === 'leased')) {
    return { action: 'wait', why: 'a delivery for this request is in flight' };
  }

  // Who has reported, by name and in any state. A blocker is not a report: a
  // team that was stuck and then unstuck still owes the work it was given.
  const reported = new Set(
    reports.filter((report) => report.kind === 'report').map((report) => report.sender),
  );
  const waitingFor = request.assignees.filter((assignee) => !reported.has(assignee));
  const ready = pending.filter((report) => report.kind === 'report');

  // Whether the main agent already had the picture: the set went out, or the
  // deadline notice did. Anything after that is late, and says so.
  const alreadyAnswered =
    request.timedOutAt !== null ||
    reports.some((report) => report.kind === 'report' && report.state === 'delivered');

  if (waitingFor.length === 0) {
    if (ready.length > 0) {
      return {
        action: 'deliver',
        reason: alreadyAnswered ? 'late' : 'complete',
        reports: ready,
        missing: [],
      };
    }
    return { action: 'finished' };
  }

  if (now < request.deadlineAt) {
    return { action: 'hold', waitingFor, deadlineAt: request.deadlineAt };
  }

  const missing = waitingFor.map((assignee) => ({ assignee, why: NO_REPORT }));

  // Rule 3, once — including when nothing at all is ready, which is the case
  // where the main agent most needs telling.
  if (request.timedOutAt === null) {
    return { action: 'deliver', reason: 'deadline', reports: ready, missing };
  }
  if (ready.length > 0) {
    return { action: 'deliver', reason: 'late', reports: ready, missing };
  }
  return {
    action: 'wait',
    why: `past the deadline and already reported; still no word from ${waitingFor.join(', ')}`,
  };
}

/** A set of reports on its way to the main agent, leased for exactly as long as it takes. */
export interface Delivery {
  readonly requestId: string;
  readonly reason: DeliveryReason;
  readonly reports: readonly StoredReport[];
  readonly missing: readonly Missing[];
}

export interface AggregatorOptions {
  readonly store: ReportStore;
  /** How long a delivery may take before its reports are offered again. */
  readonly leaseTtlMs: number;
  readonly clock?: Clock;
}

export interface Aggregator {
  decide(requestId: string): DeliveryDecision;
  /**
   * Takes the set `decide` says should go out now, or nothing.
   *
   * **All of it or none of it.** Rule 2 is that a request's reports reach the
   * main agent together, so if a lease cannot take every report the decision
   * named, the ones it did take are given back and nothing is delivered this
   * pass. Delivering the part that could be leased would be exactly the
   * fragment ADR-0014 exists to prevent.
   *
   * There is meant to be **one delivery loop per daemon**, taking, delivering
   * and settling in turn. An empty deadline notice has no reports to lease, so
   * two loops could each take it; one loop cannot.
   */
  take(requestId: string): Promise<Delivery | null>;
  /** The delivery reached the main agent. */
  settle(delivery: Delivery): Promise<Settled>;
  /** The delivery did not. Its reports are offered again. */
  giveBack(delivery: Delivery): Promise<number>;
  /** Open requests with something to deliver now, oldest first. */
  due(): readonly string[];
}

export function createAggregator(options: AggregatorOptions): Aggregator {
  const clock = options.clock ?? systemClock;
  const { store } = options;

  const decide = (requestId: string): DeliveryDecision => {
    const request = store.request(requestId);
    if (request === null) {
      throw new AppError('asked about a request that does not exist', {
        category: 'contract',
        code: 'unknown-request',
        detail: { requestId },
      });
    }
    return decideDelivery({ request, reports: store.reportsFor(requestId), now: clock.now() });
  };

  return {
    decide,

    async take(requestId) {
      const decision = decide(requestId);
      if (decision.action !== 'deliver') return null;

      const wanted = decision.reports.map((report) => report.id);
      if (wanted.length === 0) {
        return { requestId, reason: decision.reason, reports: [], missing: decision.missing };
      }

      const leased = await store.lease(wanted, options.leaseTtlMs);
      if (leased.length !== wanted.length) {
        await store.release(leased.map((report) => report.id));
        return null;
      }
      return { requestId, reason: decision.reason, reports: leased, missing: decision.missing };
    },

    settle: (delivery) =>
      store.settle(
        delivery.requestId,
        delivery.reports.map((report) => report.id),
        { deadlineNotice: delivery.reason === 'deadline' },
      ),

    giveBack: (delivery) => store.release(delivery.reports.map((report) => report.id)),

    due: () => store.openRequests().filter((requestId) => decide(requestId).action === 'deliver'),
  };
}

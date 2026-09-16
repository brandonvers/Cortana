import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newInstanceId, uuidV7 } from '@cortana/core';
import { type ManualClock, manualClock } from '@cortana/core/testing';
import {
  createWriter,
  migrateToLatest,
  openStorage,
  type Storage,
  type Writer,
} from '@cortana/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAggregator, type DeliveryDecision, decideDelivery } from './aggregate.ts';
import {
  createReportStore,
  type ReportKind,
  type ReportState,
  type ReportStore,
  type RequestRecord,
  type StoredReport,
} from './store.ts';

// ---------------------------------------------------------------------------
// The rule, as a pure function
// ---------------------------------------------------------------------------

const NOW = 1_000_000;
const DEADLINE = NOW + 60_000;

const request = (over: Partial<RequestRecord> = {}): RequestRecord => ({
  id: 'r',
  assignees: ['mail', 'research', 'writer'],
  deadlineAt: DEADLINE,
  createdAt: NOW - 1_000,
  timedOutAt: null,
  closedAt: null,
  ...over,
});

let counter = 0;
const stored = (sender: string, state: ReportState = 'pending', kind: ReportKind = 'report') => {
  counter += 1;
  return {
    id: `report-${counter}`,
    requestId: 'r',
    sender,
    kind,
    payload: { from: sender },
    state,
    attempts: state === 'pending' ? 0 : 1,
    createdAt: NOW + counter,
    deliveredAt: state === 'delivered' ? NOW + counter : null,
  } satisfies StoredReport;
};

const decide = (reports: StoredReport[], over: Partial<RequestRecord> = {}, now = NOW) =>
  decideDelivery({ request: request(over), reports, now });

const delivered = (decision: DeliveryDecision) =>
  decision.action === 'deliver' ? decision.reports.map((report) => report.sender) : null;

describe('rule 1: a team that is stuck does not wait', () => {
  it('delivers a blocker at once, and only the blocker', () => {
    const decision = decide([stored('mail'), stored('research', 'pending', 'blocker')]);

    expect(decision).toMatchObject({ action: 'deliver', reason: 'urgent' });
    // The ordinary report keeps holding for its siblings.
    expect(delivered(decision)).toEqual(['research']);
  });

  it('delivers a decision request the same way', () => {
    // ADR-0014 names both. Spike 0005 had only blockers.
    expect(decide([stored('writer', 'pending', 'decision')])).toMatchObject({
      action: 'deliver',
      reason: 'urgent',
    });
  });

  it('does not wait for a delivery already in flight', () => {
    const decision = decide([stored('mail', 'leased'), stored('research', 'pending', 'blocker')]);

    expect(decision).toMatchObject({ action: 'deliver', reason: 'urgent' });
  });

  it('does not deliver a blocker again while its delivery is in flight', () => {
    const decision = decide([stored('research', 'leased', 'blocker')]);

    expect(decision.action).not.toBe('deliver');
  });

  it('lets a second blocker through while the first is still being delivered', () => {
    // If a blocker in flight counted as ready, rule 1 would name it again, the
    // lease could not take it, and all-or-nothing would give back the new one
    // too — so a second stuck team would wait on the first one's delivery.
    const decision = decide([
      stored('research', 'leased', 'blocker'),
      stored('writer', 'pending', 'blocker'),
    ]);

    expect(decision).toMatchObject({ action: 'deliver', reason: 'urgent' });
    expect(delivered(decision)).toEqual(['writer']);
  });

  it('does not count a blocker as the report the team owes', () => {
    // A team that was stuck and then unstuck still owes the work it was given.
    const decision = decide([
      stored('mail'),
      stored('writer'),
      stored('research', 'delivered', 'blocker'),
    ]);

    expect(decision).toEqual({ action: 'hold', waitingFor: ['research'], deadlineAt: DEADLINE });
  });
});

describe('rule 2: siblings arrive together', () => {
  it('holds while anyone has not reported, and names who', () => {
    expect(decide([stored('mail')])).toEqual({
      action: 'hold',
      waitingFor: ['research', 'writer'],
      deadlineAt: DEADLINE,
    });
  });

  it('holds even with nothing yet', () => {
    expect(decide([])).toMatchObject({ action: 'hold' });
  });

  it('delivers the whole set once everyone has reported', () => {
    const decision = decide([stored('mail'), stored('research'), stored('writer')]);

    expect(decision).toMatchObject({ action: 'deliver', reason: 'complete', missing: [] });
    expect(delivered(decision)).toEqual(['mail', 'research', 'writer']);
  });

  it('holds when one agent has reported twice and another not at all', () => {
    // Spike 0005 counted reports: three expected, three arrived, "request
    // complete — delivered together" — with `writer` never heard from. A count
    // cannot tell two reports from one agent apart from one each from two.
    const decision = decide([stored('mail'), stored('mail'), stored('research')]);

    expect(decision).toEqual({ action: 'hold', waitingFor: ['writer'], deadlineAt: DEADLINE });
  });

  it('delivers every report an agent sent, not just its first', () => {
    const decision = decide([stored('mail'), stored('mail'), stored('research'), stored('writer')]);

    expect(delivered(decision)).toEqual(['mail', 'mail', 'research', 'writer']);
  });

  it('does not offer reports whose delivery is still in flight', () => {
    // Spike 0005 treated "not yet delivered" as "ready", which includes a lease
    // somebody is delivering right now.
    const decision = decide([
      stored('mail', 'leased'),
      stored('research', 'leased'),
      stored('writer'),
    ]);

    expect(decision).toMatchObject({ action: 'wait' });
  });

  it('calls a report after the set went out late, not complete', () => {
    const decision = decide([
      stored('mail', 'delivered'),
      stored('research', 'delivered'),
      stored('writer', 'delivered'),
      stored('mail'),
    ]);

    expect(decision).toMatchObject({ action: 'deliver', reason: 'late' });
    expect(delivered(decision)).toEqual(['mail']);
  });

  it('does not call a complete set late because a blocker went out earlier', () => {
    // "Already answered" means the reports went out. A blocker delivered under
    // rule 1 is not the answer to the request.
    const decision = decide([
      stored('research', 'delivered', 'blocker'),
      stored('mail'),
      stored('research'),
      stored('writer'),
    ]);

    expect(decision).toMatchObject({ action: 'deliver', reason: 'complete' });
  });

  it('is finished once everything is delivered and nobody is outstanding', () => {
    const decision = decide([
      stored('mail', 'delivered'),
      stored('research', 'delivered'),
      stored('writer', 'delivered'),
    ]);

    expect(decision).toEqual({ action: 'finished' });
  });
});

describe('rule 3: one stalled team cannot withhold the rest', () => {
  it('holds until the deadline, and not a millisecond past it', () => {
    expect(decide([stored('mail')], {}, DEADLINE - 1)).toMatchObject({ action: 'hold' });
    expect(decide([stored('mail')], {}, DEADLINE)).toMatchObject({
      action: 'deliver',
      reason: 'deadline',
    });
  });

  it('delivers what is ready and names who is missing, and why', () => {
    const decision = decide([stored('mail'), stored('writer')], {}, DEADLINE);

    expect(delivered(decision)).toEqual(['mail', 'writer']);
    expect(decision).toMatchObject({
      missing: [{ assignee: 'research', why: 'no report before the deadline' }],
    });
  });

  it('still tells the main agent when nobody reported at all', () => {
    // The case neither spike 0005 nor ADR-0014's wording covered. "Deliver what
    // is ready" with nothing ready delivers nothing, and the person who asked is
    // never answered. So the notice goes out empty, naming everyone.
    const decision = decide([], {}, DEADLINE);

    expect(decision).toMatchObject({ action: 'deliver', reason: 'deadline', reports: [] });
    expect(decision.action === 'deliver' && decision.missing.map((m) => m.assignee)).toEqual([
      'mail',
      'research',
      'writer',
    ]);
  });

  it('sends the deadline notice once', () => {
    const decision = decide([], { timedOutAt: DEADLINE }, DEADLINE + 5_000);

    expect(decision).toMatchObject({ action: 'wait' });
    expect(decision.action === 'wait' && decision.why).toContain('mail, research, writer');
  });

  it('delivers a straggler as late, naming only who is still missing', () => {
    // Spike 0005 measured "missing" against undelivered reports only, so here
    // it would have counted `mail`, already delivered at the deadline, as
    // missing again.
    const decision = decide(
      [stored('mail', 'delivered'), stored('writer')],
      { timedOutAt: DEADLINE },
      DEADLINE + 5_000,
    );

    expect(decision).toMatchObject({ action: 'deliver', reason: 'late' });
    expect(delivered(decision)).toEqual(['writer']);
    expect(decision.action === 'deliver' && decision.missing.map((m) => m.assignee)).toEqual([
      'research',
    ]);
  });

  it('finishes when the last straggler has been delivered', () => {
    const decision = decide(
      [stored('mail', 'delivered'), stored('research', 'delivered'), stored('writer', 'delivered')],
      { timedOutAt: DEADLINE },
      DEADLINE + 9_000,
    );

    expect(decision).toEqual({ action: 'finished' });
  });
});

describe('a closed request', () => {
  it('has nothing more to decide, whatever arrives', () => {
    expect(decide([stored('mail', 'pending', 'blocker')], { closedAt: NOW })).toEqual({
      action: 'closed',
    });
  });
});

// ---------------------------------------------------------------------------
// The rule, against the real store
// ---------------------------------------------------------------------------

let root: string;
let storage: Storage;
let writer: Writer;
let clock: ManualClock;
let store: ReportStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-aggregate-'));
  storage = openStorage({ dataDir: join(root, 'state') });
  migrateToLatest(storage);
  writer = createWriter({ storage });
  clock = manualClock();
  store = createReportStore({ storage, writer, instanceId: newInstanceId(), clock });
});

afterEach(async () => {
  await writer.drain();
  storage.close();
  rmSync(root, { recursive: true, force: true });
});

const aggregatorOver = (over: Partial<Parameters<typeof createAggregator>[0]> = {}) =>
  createAggregator({ store, leaseTtlMs: 60_000, clock, ...over });

const send = async (requestId: string, sender: string, kind: ReportKind = 'report') => {
  const id = uuidV7() as string;
  await store.submit({ id, requestId, sender, kind, payload: { from: sender } });
  return id;
};

const open = () =>
  store.openRequest({ assignees: ['mail', 'research', 'writer'], deadlineMs: 60_000 });

describe('spike 0005’s scenario, end to end', () => {
  it('holds, lets a blocker through, delivers the set together, and closes', async () => {
    const aggregator = aggregatorOver();
    const requestId = await open();

    await send(requestId, 'mail');
    expect(await aggregator.take(requestId)).toBeNull();

    await send(requestId, 'research');
    expect(await aggregator.take(requestId)).toBeNull();

    await send(requestId, 'writer', 'blocker');
    const urgent = await aggregator.take(requestId);
    expect(urgent?.reason).toBe('urgent');
    expect(await aggregator.settle(urgent as NonNullable<typeof urgent>)).toEqual({
      completed: 1,
      closed: false,
    });

    await send(requestId, 'writer');
    const together = await aggregator.take(requestId);
    expect(together?.reason).toBe('complete');
    expect(together?.reports.map((report) => report.sender)).toEqual([
      'mail',
      'research',
      'writer',
    ]);

    expect(await aggregator.settle(together as NonNullable<typeof together>)).toEqual({
      completed: 3,
      closed: true,
    });
    expect(store.openRequests()).toEqual([]);
  });
});

describe('taking a delivery', () => {
  it('takes all of the set or none of it', async () => {
    // Rule 2 is that the set arrives together. If one of its reports is taken
    // from under the lease — another run, a race — the rest are given back and
    // nothing goes out this pass, rather than the fragment ADR-0014 exists to
    // prevent.
    const requestId = await open();
    const ids = [
      await send(requestId, 'mail'),
      await send(requestId, 'research'),
      await send(requestId, 'writer'),
    ];
    const other = createReportStore({ storage, writer, instanceId: newInstanceId(), clock });

    const aggregator = aggregatorOver({
      store: {
        ...store,
        lease: async (wanted, ttlMs) => {
          await other.lease([wanted[0] as string], ttlMs);
          return store.lease(wanted, ttlMs);
        },
      },
    });

    expect(await aggregator.take(requestId)).toBeNull();
    // What this run did take went straight back.
    expect(store.get(ids[1] as string)?.state).toBe('pending');
    expect(store.get(ids[2] as string)?.state).toBe('pending');
  });

  it('can be given back, and is offered again whole', async () => {
    const aggregator = aggregatorOver();
    const requestId = await open();
    for (const sender of ['mail', 'research', 'writer']) await send(requestId, sender);

    const first = await aggregator.take(requestId);
    expect(await aggregator.giveBack(first as NonNullable<typeof first>)).toBe(3);

    const again = await aggregator.take(requestId);
    expect(again?.reason).toBe('complete');
    expect(again?.reports).toHaveLength(3);
  });

  it('refuses to decide about a request that does not exist', () => {
    expect(() => aggregatorOver().decide('nothing')).toThrow(
      expect.objectContaining({ category: 'contract', code: 'unknown-request' }),
    );
  });
});

describe('the deadline notice', () => {
  it('goes out empty, once, and leaves the request open for stragglers', async () => {
    const aggregator = aggregatorOver();
    const requestId = await open();
    clock.advance(60_000);

    const notice = await aggregator.take(requestId);
    expect(notice).toMatchObject({ reason: 'deadline', reports: [] });
    expect(notice?.missing).toHaveLength(3);
    expect(await aggregator.settle(notice as NonNullable<typeof notice>)).toEqual({
      completed: 0,
      closed: false,
    });

    // Without the recorded notice this would go out again on every pass.
    clock.advance(1_000);
    expect(await aggregator.take(requestId)).toBeNull();
    expect(store.request(requestId)?.timedOutAt).not.toBeNull();
    expect(store.openRequests()).toEqual([requestId]);
  });

  it('is not marked sent when this run lost a lease before settling', async () => {
    // Another run reclaimed one of the notice's reports and holds it now. The
    // notice was not this run's to deliver; whoever holds it will send it.
    const aggregator = aggregatorOver();
    const requestId = await open();
    await send(requestId, 'mail');
    clock.advance(60_000);

    const notice = await aggregator.take(requestId);
    const later = createReportStore({ storage, writer, instanceId: newInstanceId(), clock });
    await later.reclaimAtBoot();
    await later.lease(
      (notice as NonNullable<typeof notice>).reports.map((r) => r.id),
      60_000,
    );

    expect(await aggregator.settle(notice as NonNullable<typeof notice>)).toEqual({
      completed: 0,
      closed: false,
    });
    expect(store.request(requestId)?.timedOutAt).toBeNull();
  });

  it('delivers a straggler late, and closes when the last one is in', async () => {
    const aggregator = aggregatorOver();
    const requestId = await open();
    await send(requestId, 'mail');
    clock.advance(60_000);
    const notice = await aggregator.take(requestId);
    await aggregator.settle(notice as NonNullable<typeof notice>);

    await send(requestId, 'research');
    const late = await aggregator.take(requestId);
    expect(late).toMatchObject({ reason: 'late' });
    expect(late?.missing.map((m) => m.assignee)).toEqual(['writer']);
    expect((await aggregator.settle(late as NonNullable<typeof late>)).closed).toBe(false);

    await send(requestId, 'writer');
    const last = await aggregator.take(requestId);
    expect(await aggregator.settle(last as NonNullable<typeof last>)).toEqual({
      completed: 1,
      closed: true,
    });
  });
});

describe('what is due', () => {
  it('lists only requests with something to deliver now', async () => {
    const aggregator = aggregatorOver();
    const holding = await open();
    const blocked = await open();
    const complete = await open();
    await send(holding, 'mail');
    await send(blocked, 'writer', 'blocker');
    for (const sender of ['mail', 'research', 'writer']) await send(complete, sender);

    expect(aggregator.due()).toEqual([blocked, complete]);
  });
});

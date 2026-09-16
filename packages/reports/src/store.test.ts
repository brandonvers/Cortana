import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InstanceId, isAppError, newInstanceId, uuidV7 } from '@cortana/core';
import { type ManualClock, manualClock } from '@cortana/core/testing';
import {
  createWriter,
  migrateToLatest,
  openStorage,
  type Storage,
  type Writer,
} from '@cortana/storage';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reports } from './schema.ts';
import { createReportStore, MAX_PAYLOAD_BYTES, type ReportStore } from './store.ts';

let root: string;
let storage: Storage;
let writer: Writer;
let clock: ManualClock;
let instance: InstanceId;
let store: ReportStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-reports-'));
  storage = openStorage({ dataDir: join(root, 'state') });
  migrateToLatest(storage);
  writer = createWriter({ storage });
  clock = manualClock();
  instance = newInstanceId();
  store = createReportStore({ storage, writer, instanceId: instance, clock });
});

afterEach(async () => {
  await writer.drain();
  storage.close();
  rmSync(root, { recursive: true, force: true });
});

/** Another run of the daemon, against the same database. */
const anotherRun = () => createReportStore({ storage, writer, instanceId: newInstanceId(), clock });

const report = (requestId: string, over: Record<string, unknown> = {}) => ({
  id: uuidV7() as string,
  requestId,
  sender: 'mail',
  kind: 'report' as const,
  payload: { summary: 'three enquiries, one urgent' },
  ...over,
});

const opened = () =>
  store.openRequest({ assignees: ['mail', 'research', 'writer'], deadlineMs: 60_000 });

describe('opening a request', () => {
  it('refuses one given to nobody', async () => {
    // A request nobody works on is not a request, and ADR-0014's "hold until
    // the outstanding work is done" would be done before it started.
    await expect(store.openRequest({ assignees: [], deadlineMs: 60_000 })).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'request-expects-nothing',
    );
  });

  it('refuses an assignee with no name', async () => {
    await expect(
      store.openRequest({ assignees: ['mail', '  '], deadlineMs: 60_000 }),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'request-unnamed-assignee',
    );
  });

  it('refuses the same agent twice rather than quietly counting it once', async () => {
    // Deduplicating here would hide a delegation that went wrong upstream, and
    // the symptom would turn up later as a request that never adds up.
    await expect(
      store.openRequest({ assignees: ['mail', 'mail'], deadlineMs: 60_000 }),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'request-duplicate-assignee',
    );
  });

  it('remembers who it was given to, and is open until closed', async () => {
    const requestId = await store.openRequest({
      assignees: ['writer', 'mail'],
      deadlineMs: 60_000,
    });

    expect(store.request(requestId)?.assignees).toEqual(['mail', 'writer']);
    expect(store.request(requestId)?.closedAt).toBeNull();
    expect(store.openRequests()).toEqual([requestId]);
  });

  it('refuses one with no deadline', async () => {
    // ADR-0014's third rule exists so one stalled team cannot withhold what its
    // siblings finished. A request without a deadline has no third rule.
    await expect(store.openRequest({ assignees: ['mail'], deadlineMs: 0 })).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'request-without-deadline',
    );
  });
});

describe('submitting a report', () => {
  it('is on disk by the time it is acknowledged', async () => {
    const requestId = await opened();
    const sent = report(requestId);

    await store.submit(sent);

    // Read back through a different path from the one that wrote it.
    const row = storage.connection.prepare('select state from reports where id = ?').get(sent.id);
    expect(row).toEqual({ state: 'pending' });
  });

  it('accepts a retry of the same report as a no-op, and says so', async () => {
    // Spike 0005 measured a write landing without its acknowledgement — 38 on
    // disk to 37 acknowledged — and called that the safe direction only because
    // the sender's retry is harmless. This is the retry.
    const requestId = await opened();
    const sent = report(requestId);

    expect(await store.submit(sent)).toEqual({ accepted: true });
    expect(await store.submit({ ...sent, payload: { summary: 'different' } })).toEqual({
      accepted: false,
    });

    expect(store.outstanding(requestId)).toHaveLength(1);
    // The first one stands. A retry does not get to rewrite what was reported.
    expect(store.get(sent.id)?.payload).toEqual({ summary: 'three enquiries, one urgent' });
  });

  it('refuses a report for a request that does not exist', async () => {
    await expect(store.submit(report('no-such-request'))).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'report-for-unknown-request',
    );
  });

  it('refuses a report from an agent the request was not given to', async () => {
    // Nothing an agent says about itself decides what it was asked to do. A
    // report from outside the assignment would reach the main agent as though
    // it had been.
    const requestId = await opened();

    await expect(store.submit(report(requestId, { sender: 'stranger' }))).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'report-from-unassigned-sender',
    );
  });

  it('refuses a new report once the request has finished, but not a retry', async () => {
    // The order matters: a sender that crashed without learning its report
    // landed, retrying after the request closed, is told "already have it" —
    // not that it broke a rule it did not break.
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await store.close(requestId);

    expect(await store.submit(sent)).toEqual({ accepted: false });
    await expect(store.submit(report(requestId))).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'report-for-closed-request',
    );
  });

  it('refuses a payload larger than anybody would read', async () => {
    // The payload is model output. Without a limit, a runaway turn decides how
    // large the database gets.
    const requestId = await opened();
    const huge = { text: 'x'.repeat(MAX_PAYLOAD_BYTES) };

    await expect(store.submit(report(requestId, { payload: huge }))).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'report-too-large',
    );
  });

  it('refuses a payload that is not JSON, or is not there', async () => {
    const requestId = await opened();

    await expect(store.submit(report(requestId, { payload: 10n }))).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'report-not-json',
    );
    await expect(store.submit(report(requestId, { payload: undefined }))).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'report-without-payload',
    );
  });
});

describe('closing a request', () => {
  it('happens once, and takes it out of what is open', async () => {
    const first = await opened();
    const second = await opened();

    expect(await store.close(first)).toBe(true);
    expect(await store.close(first)).toBe(false);
    expect(store.openRequests()).toEqual([second]);
    expect(store.request(first)?.closedAt).not.toBeNull();
  });
});

describe('leasing', () => {
  it('hands back only the reports it actually took', async () => {
    const requestId = await opened();
    const one = report(requestId);
    const two = report(requestId);
    await store.submit(one);
    await store.submit(two);

    const first = await store.lease([one.id, two.id], 30_000);
    const second = await store.lease([one.id, two.id], 30_000);

    expect(first.map((r) => r.id).sort()).toEqual([one.id, two.id].sort());
    // Spike 0005's lease returned every row it had read, including rows another
    // caller had taken in between. A report handed out twice is delivered twice.
    expect(second).toEqual([]);
  });

  it('gives each report to one caller when two ask at once', async () => {
    const requestId = await opened();
    const sent = [report(requestId), report(requestId), report(requestId)];
    for (const r of sent) await store.submit(r);
    const ids = sent.map((r) => r.id);

    const [a, b] = await Promise.all([store.lease(ids, 30_000), store.lease(ids, 30_000)]);

    const handedOut = [...a, ...b].map((r) => r.id);
    expect(handedOut.sort()).toEqual([...ids].sort());
    expect(new Set(handedOut).size).toBe(handedOut.length);
  });

  it('ignores ids it has never heard of', async () => {
    expect(await store.lease(['nothing-by-this-name'], 30_000)).toEqual([]);
  });
});

describe('a report redelivered three times', () => {
  it('is completed once', async () => {
    // M4's definition of done, word for word: "one redelivered three times has
    // effect once".
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);

    await store.lease([sent.id], 30_000);
    await store.release([sent.id]);
    await store.lease([sent.id], 30_000);
    await store.release([sent.id]);
    await store.lease([sent.id], 30_000);

    const completions = [
      await store.complete([sent.id]),
      await store.complete([sent.id]),
      await store.complete([sent.id]),
    ];

    expect(completions).toEqual([1, 0, 0]);
    expect(store.get(sent.id)?.state).toBe('delivered');
    // Three leases, and the count says so — a number that keeps growing on one
    // report is the symptom of a delivery that keeps failing.
    expect(store.get(sent.id)?.attempts).toBe(3);
  });

  it('keeps its first delivery time', async () => {
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await store.lease([sent.id], 30_000);
    await store.complete([sent.id]);
    const first = store.get(sent.id)?.deliveredAt;

    clock.advance(5_000);
    await store.complete([sent.id]);

    expect(store.get(sent.id)?.deliveredAt).toBe(first);
  });
});

describe('completing', () => {
  it('does nothing to a report that was never leased', async () => {
    // Completing is the end of a delivery. Something that was never handed out
    // was not delivered, and marking it so would lose it.
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);

    expect(await store.complete([sent.id])).toBe(0);
    expect(store.get(sent.id)?.state).toBe('pending');
  });

  it('does nothing to a lease that is no longer this run’s', async () => {
    // This run leased it and stalled; a restart reclaimed it and leased it
    // again. If the stalled run then completed it, a report its current holder
    // has not yet delivered would be marked delivered — and never delivered.
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await store.lease([sent.id], 30_000);

    const later = anotherRun();
    await later.reclaimAtBoot();
    await later.lease([sent.id], 30_000);

    expect(await store.complete([sent.id])).toBe(0);
    expect(await later.complete([sent.id])).toBe(1);
  });

  it('does nothing to a row that says pending but still names this run', async () => {
    // Every transition out of `leased` clears the owner in the same update, so
    // this code never writes such a row — and the owner check alone would stop
    // it being completed. The state check is the second statement of the rule,
    // for a row an older build or an interrupted write left behind: a report
    // nobody is delivering must not be marked delivered because a stale column
    // still carries this run's name.
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await writer.write('an interrupted release left this', ({ db }) => {
      db.update(reports)
        .set({ state: 'pending', leaseOwner: instance as string })
        .where(eq(reports.id, sent.id))
        .run();
    });

    expect(await store.complete([sent.id])).toBe(0);
    expect(store.get(sent.id)?.state).toBe('pending');
  });

  it('removes a delivered report from what is outstanding', async () => {
    const requestId = await opened();
    const one = report(requestId);
    const two = report(requestId);
    await store.submit(one);
    await store.submit(two);
    await store.lease([one.id], 30_000);
    await store.complete([one.id]);

    expect(store.outstanding(requestId).map((r) => r.id)).toEqual([two.id]);
  });
});

describe('releasing', () => {
  it('gives a failed delivery back, so it is delivered again', async () => {
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await store.lease([sent.id], 30_000);

    expect(await store.release([sent.id])).toBe(1);
    expect(store.get(sent.id)?.state).toBe('pending');
    expect(await store.lease([sent.id], 30_000)).toHaveLength(1);
  });

  it('does nothing to a lease that is no longer this run’s', async () => {
    // The mirror of the completion case, and the worse of the two. This run
    // stalled and its delivery failed; meanwhile a restart reclaimed the report
    // and is delivering it now. If the stalled run's release still counted, the
    // report would drop back to pending under a delivery in progress — and be
    // handed out a second time, concurrently, by whoever leases it next.
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await store.lease([sent.id], 30_000);

    const later = anotherRun();
    await later.reclaimAtBoot();
    await later.lease([sent.id], 30_000);

    expect(await store.release([sent.id])).toBe(0);
    expect(store.get(sent.id)?.state).toBe('leased');
    expect(await later.complete([sent.id])).toBe(1);
  });
});

describe('after a restart', () => {
  it('every lease from the previous run is returned, however long it had left', async () => {
    // Spike 0005 only reclaimed expired leases. At boot, every lease belongs to
    // a process that no longer exists, and waiting out its TTL only delays work
    // already known to be stranded.
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await store.lease([sent.id], 3_600_000);

    const reclaimed = await anotherRun().reclaimAtBoot();

    expect(reclaimed).toBe(1);
    expect(store.get(sent.id)?.state).toBe('pending');
  });

  it('this run’s own leases are left alone', async () => {
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await store.lease([sent.id], 30_000);

    expect(await store.reclaimAtBoot()).toBe(0);
    expect(store.get(sent.id)?.state).toBe('leased');
  });

  it('a lease with no owner is returned too', async () => {
    // In SQL `lease_owner != 'x'` is NULL rather than true when the owner is
    // NULL, so a leased row with no owner — an older build, an interrupted
    // write — would match nothing and stay leased forever.
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await writer.write('an older build left this', ({ db }) => {
      db.update(reports)
        .set({ state: 'leased', leaseOwner: null })
        .where(eq(reports.id, sent.id))
        .run();
    });

    expect(await store.reclaimAtBoot()).toBe(1);
  });
});

describe('an expired lease', () => {
  it('is returned once its time has run out, and not before', async () => {
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await store.lease([sent.id], 30_000);

    clock.advance(29_999);
    expect(await store.reclaimExpired()).toBe(0);

    clock.advance(2);
    expect(await store.reclaimExpired()).toBe(1);
    expect(store.get(sent.id)?.state).toBe('pending');
  });

  it('includes a lease with no expiry at all', async () => {
    const requestId = await opened();
    const sent = report(requestId);
    await store.submit(sent);
    await writer.write('an interrupted lease', ({ db }) => {
      db.update(reports)
        .set({ state: 'leased', leaseOwner: 'someone', leaseUntil: null })
        .where(eq(reports.id, sent.id))
        .run();
    });

    expect(await store.reclaimExpired()).toBe(1);
  });
});

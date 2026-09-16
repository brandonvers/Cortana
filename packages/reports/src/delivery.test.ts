import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newInstanceId } from '@cortana/core';
import { createWriter, migrateToLatest, openStorage } from '@cortana/storage';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reports } from './schema.ts';
import { createReportStore } from './store.ts';

/**
 * A report survives the process dying in the middle of delivering it.
 *
 * M4's definition of done: "a report survives SIGKILL mid-delivery". M1 already
 * promoted spike 0005's kill test for the writer, and that proves an
 * acknowledged write is on disk. It does not prove what a report store adds on
 * top: that a report **handed out and never finished** — leased, and then its
 * process gone — is found again and delivered, rather than sitting in a lease
 * nobody holds for ever.
 *
 * Two kinds of kill, because they prove different things. An **aimed** kill
 * lands on a report that is certainly out and unfinished, which is the case the
 * definition of done names. An **unaimed** kill lands wherever it lands, inside
 * the write path or between writes, and checks that nothing is lost or stranded
 * whichever it was. The aimed version exists because the first attempt at aiming
 * with timing alone was not aiming; `delivery-probe.ts` says what happened.
 *
 * ## What it does not prove
 *
 * The same things the storage kill test says it does not: nothing about
 * `synchronous = FULL`, since `SIGKILL` leaves the kernel's page cache intact,
 * and nothing about a kill inside an fsync. And nothing about the consumer: the
 * guarantee is at-least-once delivery, so a report the dead process had already
 * handed to a model turn is handed over again, and only the consumer can make
 * that harmless. `store.ts` states that bargain; this checks the store's half.
 */

const PROBE = join(import.meta.dirname, 'delivery-probe.ts');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-delivery-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Killed {
  readonly dataDir: string;
  readonly submitted: readonly string[];
  readonly leased: readonly string[];
  readonly completed: readonly string[];
  readonly held: string | null;
  readonly signal: NodeJS.Signals | null;
}

type Lines = (kind: string) => string[];

/** Runs the probe, and kills it the first time `shouldKill` says so. */
function runProbe(
  name: string,
  shouldKill: (lines: Lines) => boolean,
  holdAt?: number,
): Promise<Killed> {
  const dataDir = join(root, name);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, dataDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(holdAt === undefined ? {} : { HOLD_AT: String(holdAt) }) },
    });
    let out = '';
    let err = '';
    let killed = false;

    const lines: Lines = (kind) =>
      [...out.matchAll(new RegExp(`^${kind} (\\S+)$`, 'gm'))].map((match) => match[1] as string);

    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      if (killed || !shouldKill(lines)) return;
      killed = true;
      // SIGKILL: no handler, no drain, no close.
      child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      err += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (!killed) {
        reject(new Error(`the probe exited on its own (code ${code}). stderr:\n${err}`));
        return;
      }
      // Read after exit, so every line the process managed to write before it
      // died is counted — including any written after the signal was sent.
      resolve({
        dataDir,
        submitted: lines('submitted'),
        leased: lines('leased'),
        completed: lines('completed'),
        held: lines('holding')[0] ?? null,
        signal,
      });
    });
  });
}

/** Opens what the dead process left, as the next run of the daemon would. */
function nextRun(dataDir: string) {
  const storage = openStorage({ dataDir });
  migrateToLatest(storage);
  const writer = createWriter({ storage });
  const store = createReportStore({ storage, writer, instanceId: newInstanceId() });
  const rows = () =>
    storage.db
      .select()
      .from(reports)
      .all()
      .map((row) => ({
        ...row,
        payload: JSON.parse(row.payload) as { seq: number; check: number },
      }));
  return {
    store,
    rows,
    close: async () => {
      await writer.drain();
      storage.close();
    },
  };
}

/**
 * What must be true after any kill, aimed or not: nothing acknowledged is lost
 * or torn, nothing is stranded in a lease once the next run boots, everything
 * can be delivered, and delivering it again completes nothing twice.
 */
async function assertRecovers(killed: Killed, run: ReturnType<typeof nextRun>): Promise<void> {
  const before = new Map(run.rows().map((row) => [row.id, row]));

  for (const id of killed.submitted) expect(before.has(id), `submitted ${id}`).toBe(true);
  for (const row of before.values()) expect(row.payload.check).toBe(row.payload.seq);
  for (const id of killed.completed) {
    expect(before.get(id)?.state, `completed ${id}`).toBe('delivered');
  }

  await run.store.reclaimAtBoot();
  expect(run.rows().filter((row) => row.state === 'leased')).toEqual([]);

  const outstanding = run
    .rows()
    .filter((row) => row.state !== 'delivered')
    .map((row) => row.id);
  const taken = await run.store.lease(outstanding, 60_000);
  expect(taken.map((report) => report.id).sort()).toEqual([...outstanding].sort());
  expect(await run.store.complete(outstanding)).toBe(outstanding.length);

  const after = run.rows();
  expect(after.every((row) => row.state === 'delivered')).toBe(true);
  expect(await run.store.complete(after.map((row) => row.id))).toBe(0);
}

describe('a report handed out when the process died', () => {
  for (const holdAt of [7, 41, 113]) {
    it(`is found and delivered after a SIGKILL while report ${holdAt} is out`, async () => {
      const killed = await runProbe(
        `held-${holdAt}`,
        (lines) => lines('holding').length > 0,
        holdAt,
      );
      expect(killed.signal).toBe('SIGKILL');
      expect(killed.held).not.toBeNull();

      const run = nextRun(killed.dataDir);
      try {
        const held = killed.held as string;
        // Certainly out, certainly unfinished: the probe stopped before
        // completing it, so no completion can have landed unacknowledged. This
        // is the row a store that only reclaimed expired leases would strand
        // for the lease's full hour.
        expect(killed.completed).not.toContain(held);
        expect(run.rows().find((row) => row.id === held)?.state).toBe('leased');

        await assertRecovers(killed, run);
        expect(run.rows().find((row) => row.id === held)?.state).toBe('delivered');
      } finally {
        await run.close();
      }
    }, 60_000);
  }
});

describe('wherever the kill lands', () => {
  for (const acks of [20, 97, 233]) {
    it(`loses and strands nothing after a SIGKILL at acknowledgement ${acks}`, async () => {
      const killed = await runProbe(
        `free-${acks}`,
        (lines) =>
          lines('submitted').length + lines('leased').length + lines('completed').length >= acks,
      );
      expect(killed.signal).toBe('SIGKILL');

      const run = nextRun(killed.dataDir);
      try {
        // A lease acknowledged and never acknowledged as completed may be still
        // leased, or delivered if its completion landed first — spike 0005's
        // 38-on-disk-to-37-acknowledged, the safe direction. Recorded as a
        // property of whichever report it was, not required to exist: an unaimed
        // kill does not always land there, which is why the aimed test does.
        const before = new Map(run.rows().map((row) => [row.id, row.state]));
        for (const id of killed.leased.filter((leased) => !killed.completed.includes(leased))) {
          expect(['leased', 'delivered'], `unfinished ${id}`).toContain(before.get(id));
        }

        await assertRecovers(killed, run);
      } finally {
        await run.close();
      }
    }, 60_000);
  }
});

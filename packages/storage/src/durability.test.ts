import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from './open.ts';

/**
 * Spike 0005's kill test, promoted into the repository.
 *
 * The spike proved that acknowledged writes survive a `SIGKILL` on both
 * filesystems, and then it was deleted, as spikes are. That left the project's
 * most load-bearing claim — everything else about resilience reduces to it —
 * true of a script nobody can run any more. This is that claim as a fact about
 * this codebase, against the real writer, the real transaction, and the real
 * PRAGMAs from ADR-0017.
 *
 * Durability cannot be unit tested. It is a claim about what happens when a
 * process **stops existing** mid-write, so it needs a real child, a real
 * `SIGKILL`, and the file reopened afterwards.
 *
 * ## What it catches, measured by breaking it
 *
 * Acknowledging a write before it has landed fails all five of these, naming
 * every missing sequence number. That is the property, and the test has teeth
 * for it.
 *
 * ## What it does not prove, measured the same way
 *
 * **It says nothing about `synchronous`.** Setting it to `NORMAL`, or to `OFF`,
 * leaves every test here green. That is not a gap in the harness; it is what
 * `SIGKILL` means. The process stops existing, but the writes it handed to the
 * kernel are in the page cache, and the kernel is still running — so they reach
 * the disk regardless of how carefully SQLite asked. Spike 0005 said exactly
 * this about itself: `NORMAL` "is sufficient for *process* crashes — the case
 * actually tested here".
 *
 * So [ADR-0017](../../../docs/adr/0017-durability-over-throughput.md)'s choice
 * of `FULL` rests on its own argument and **is not validated by this file**.
 * What would validate it is power loss or a kernel panic, which needs hardware
 * or a virtual machine reset rather than a signal. Nothing here should be quoted
 * as evidence for that setting.
 *
 * It also says nothing about a kill landing *inside* an fsync. Spike 0005 was
 * explicit that this is a kernel and hardware guarantee the project relies on
 * rather than tests, and that has not changed.
 */

const PROBE = join(import.meta.dirname, 'durability-probe.ts');

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-durability-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface KillResult {
  readonly dataDir: string;
  /** Writes this process was told had landed, before it stopped existing. */
  readonly acknowledged: number;
  readonly signal: NodeJS.Signals | null;
  readonly walPresentAtKill: boolean;
}

/** Runs the probe until it has acknowledged `target` writes, then kills it dead. */
function killAfter(target: number, name: string): Promise<KillResult> {
  const dataDir = join(root, name);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let acknowledged = 0;
    let walPresentAtKill = false;
    let killed = false;

    child.stdout.on('data', (chunk) => {
      out += String(chunk);
      acknowledged = (out.match(/^ack /gm) ?? []).length;
      if (!killed && acknowledged >= target) {
        killed = true;
        walPresentAtKill = existsSync(join(dataDir, 'cortana.db-wal'));
        // SIGKILL, not SIGTERM. Nothing runs on the way out: no handler, no
        // drain, no close. Whatever is on disk is what the operating system and
        // SQLite left there.
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (_code, signal) => {
      if (acknowledged < target) {
        reject(new Error(`the probe stopped after ${acknowledged} acks. Output:\n${out}`));
        return;
      }
      resolve({ dataDir, acknowledged, signal, walPresentAtKill });
    });
  });
}

interface Audit {
  readonly onDisk: number;
  readonly missing: number[];
  readonly torn: number[];
}

/** Reopens the file the killed process left behind and reads what survived. */
function audit(dataDir: string, acknowledged: number): Audit {
  const storage = openStorage({ dataDir });
  try {
    const rows = storage.connection
      .prepare('select seq, payload from probe order by seq')
      .all() as { seq: number; payload: string }[];

    const seen = new Set(rows.map((row) => row.seq));
    const missing: number[] = [];
    for (let seq = 1; seq <= acknowledged; seq++) {
      if (!seen.has(seq)) missing.push(seq);
    }

    // Each payload carries its sequence number twice. A record written
    // partially would disagree with itself, which makes tearing detectable
    // rather than merely unlikely.
    const torn = rows
      .filter((row) => row.payload !== `record|${row.seq}|${row.seq}`)
      .map((row) => row.seq);

    return { onDisk: rows.length, missing, torn };
  } finally {
    storage.close();
  }
}

describe('nothing acknowledged is lost when the process stops existing', () => {
  // The same shape as the spike: several kills at different points in a run,
  // because a test that always kills at the same moment may only be proving
  // that SIGKILL arrives between operations.
  for (const target of [37, 113, 251]) {
    it(`keeps all ${target} acknowledged writes across a SIGKILL`, async () => {
      const result = await killAfter(target, `run-${target}`);

      expect(result.signal).toBe('SIGKILL');
      expect(result.acknowledged).toBeGreaterThanOrEqual(target);

      const { onDisk, missing, torn } = audit(result.dataDir, result.acknowledged);

      expect(missing).toEqual([]);
      expect(torn).toEqual([]);

      // The guarantee is one-directional, and this is the safe direction. A
      // write that landed without being acknowledged costs nothing: the
      // caller never learned it succeeded. A write that was acknowledged and
      // did not land is the catastrophic case, and it is the one asserted
      // above. Spike 0005 saw 38 on disk against 37 acknowledged and treated
      // that as the result working, not as a discrepancy.
      expect(onDisk).toBeGreaterThanOrEqual(result.acknowledged);
    }, 30_000);
  }

  it('recovers from the write-ahead log the killed process left behind', async () => {
    // Nothing ran on the way out, so the -wal file is still there with
    // committed frames in it. Reopening is what folds them in; if that did
    // not work, every assertion above would be reading an empty table.
    const result = await killAfter(60, 'wal-recovery');

    expect(result.walPresentAtKill).toBe(true);
    expect(existsSync(join(result.dataDir, 'cortana.db-wal'))).toBe(true);

    const { onDisk } = audit(result.dataDir, result.acknowledged);
    expect(onDisk).toBeGreaterThanOrEqual(result.acknowledged);

    // Opening it cleanly checkpoints the log away, so a copy of the file is a
    // complete copy from here on.
    expect(existsSync(join(result.dataDir, 'cortana.db-wal'))).toBe(false);
  }, 30_000);

  it('reports whether the kill landed inside the write path', async () => {
    // Recorded rather than asserted, because it is not deterministic. More on
    // disk than acknowledged means the process died between the commit and
    // the acknowledgement — evidence the kill landed in the middle of the
    // write path rather than in a quiet moment between operations, which is
    // what makes the result above worth anything. A run where the numbers
    // match exactly is not a failure; a run where they never differ across
    // many attempts would be a reason to distrust the harness.
    const result = await killAfter(150, 'landing');
    const { onDisk } = audit(result.dataDir, result.acknowledged);

    const unacknowledgedButLanded = onDisk - result.acknowledged;
    expect(unacknowledgedButLanded).toBeGreaterThanOrEqual(0);
  }, 30_000);
});

/**
 * The child half of the delivery test. Not a test, and not shipped behaviour —
 * it exists to be killed.
 *
 * Each iteration takes one report through its whole life — submitted, leased,
 * completed — and says so after each step lands, with a synchronous write to
 * file descriptor 1. Synchronous because Node buffers `process.stdout` on a
 * pipe, and an acknowledgement sitting in a buffer is one the parent never
 * counts; `durability-probe.ts` in storage explains the same trap.
 *
 * ## Why it can be told to stop and wait
 *
 * The first version of the test tried to aim the kill by sending `SIGKILL` the
 * moment a `leased` line arrived. That is not aiming: the signal is delivered
 * asynchronously, the process carries on for a moment, and the `completed` line
 * for the same report often arrived before it died. The kill then landed *after*
 * the delivery, and the test failed for a reason that was about the harness and
 * not the store — twice in three runs under load, never on an idle machine.
 *
 * So with `HOLD_AT=n` the probe stops after acknowledging its n-th lease and
 * does nothing else until it is killed. The kill then lands on a report that is
 * certainly out and certainly unfinished, which is the case M4's definition of
 * done names. Without `HOLD_AT` it runs freely, for the test that lets the kill
 * land wherever it lands.
 *
 *   HOLD_AT=41 node delivery-probe.ts <dataDir>
 */

import { writeSync } from 'node:fs';
import { newInstanceId, uuidV7 } from '@cortana/core';
import { createWriter, migrateToLatest, openStorage } from '@cortana/storage';
import { createReportStore } from './store.ts';

const dataDir = process.argv[2];
if (!dataDir) {
  writeSync(2, 'usage: [HOLD_AT=n] delivery-probe.ts <dataDir>\n');
  process.exit(64);
}
const holdAt = process.env['HOLD_AT'] === undefined ? null : Number(process.env['HOLD_AT']);

const storage = openStorage({ dataDir });
migrateToLatest(storage);
const writer = createWriter({ storage });
const store = createReportStore({ storage, writer, instanceId: newInstanceId() });

const requestId = await store.openRequest({ expected: 1_000_000, deadlineMs: 3_600_000 });
writeSync(1, `ready ${requestId}\n`);

for (let seq = 1; ; seq += 1) {
  const id = uuidV7() as string;
  // The sequence number twice, as in the storage probe: without it a torn
  // payload is merely unlikely, with it one is detectable.
  await store.submit({
    id,
    requestId,
    sender: 'probe',
    kind: 'report',
    payload: { seq, check: seq },
  });
  writeSync(1, `submitted ${id}\n`);

  const leased = await store.lease([id], 3_600_000);
  if (leased.length !== 1) {
    writeSync(2, `lease took ${leased.length} of 1 for ${id}\n`);
    process.exit(70);
  }
  writeSync(1, `leased ${id}\n`);

  if (seq === holdAt) {
    writeSync(1, `holding ${id}\n`);
    // A timer, and not merely a promise that never settles: an unsettled
    // promise does not keep Node's event loop alive, and the process would
    // exit cleanly — which M1 learned the hard way about signal handlers.
    setInterval(() => undefined, 1 << 30);
    await new Promise(() => undefined);
  }

  await store.complete([id]);
  writeSync(1, `completed ${id}\n`);
}

/**
 * The child half of the durability test. Not a test itself, and not shipped
 * behaviour — it exists to be killed.
 *
 * It writes through the real path, one acknowledged record at a time, and
 * reports each acknowledgement on file descriptor 1 with a synchronous write.
 * Synchronous matters: Node buffers `process.stdout` when it is a pipe, and a
 * buffered acknowledgement is one the parent never sees. Under-counting would
 * be the safe direction — the parent would simply expect less — but it would
 * also mean the parent never reaches its kill point, so the test would measure
 * the buffer rather than the database.
 *
 * Each payload carries its sequence number a second time. That is spike 0005's
 * device and it is worth keeping: without it, a partially written record is
 * merely unlikely; with it, one is detectable.
 *
 *   node durability-probe.ts <dataDir>
 */

import { writeSync } from 'node:fs';
import { openStorage } from './open.ts';
import { createWriter } from './writer.ts';

const dataDir = process.argv[2];
if (!dataDir) {
  writeSync(2, 'usage: durability-probe.ts <dataDir>\n');
  process.exit(64);
}

const storage = openStorage({ dataDir });
storage.connection.exec(
  'create table if not exists probe (seq integer primary key, payload text not null)',
);

const writer = createWriter({ storage });
const insert = storage.connection.prepare('insert into probe (seq, payload) values (?, ?)');

writeSync(1, 'ready\n');

let seq = 0;
for (;;) {
  seq += 1;
  const current = seq;
  await writer.write('probe', () => {
    insert.run(current, `record|${current}|${current}`);
  });
  // Only after the write is acknowledged. Everything the parent counts here is
  // something this process was told had landed.
  writeSync(1, `ack ${current}\n`);
}

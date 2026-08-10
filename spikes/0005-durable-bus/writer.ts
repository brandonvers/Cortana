/**
 * The victim.
 *
 * Writes messages one at a time and prints the id of each one AFTER `send()`
 * returns — that print is the acknowledgement. The parent kills this process at
 * an unpredictable point and then checks that every id printed here is in the
 * database.
 *
 * Run as a child process, never directly.
 */

import { Bus } from './bus.ts';

const dbPath = process.argv[2] as string;
const requestId = process.argv[3] as string;
const count = Number(process.argv[4] ?? 500);

const bus = new Bus(dbPath);

for (let i = 0; i < count; i++) {
  const id = `${requestId}-msg-${String(i).padStart(4, '0')}`;
  bus.send({
    id,
    requestId,
    sender: 'writer',
    recipient: 'orchestrator',
    kind: 'report',
    // Large enough that a torn write would be visible as malformed JSON rather
    // than passing unnoticed.
    payload: { seq: i, note: 'x'.repeat(400), nested: { ok: true, seq: i } },
  });
  // ACK. Everything printed here must survive the kill.
  process.stdout.write(`ACK ${id}\n`);
}

bus.close();
process.stdout.write('DONE\n');

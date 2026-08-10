/**
 * Spike 0005 — does the bus survive being killed?
 *
 * Throwaway. See README.md for the pass criteria, written down before this ran.
 *
 * Part A kills a real child process, at an unpredictable point, in the middle of
 * real writes to a real file, and then checks that every write the child
 * acknowledged is still there. Durability is a claim about what happens when a
 * process stops existing; it cannot be tested any other way.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { arch, type as osType, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import {
  budgetCeilingUsd,
  costWarning,
  formatUsage,
  MODEL,
  structuredTurnBudget,
} from '../model.ts';
import { Bus, type StoredMessage } from './bus.ts';

const FREE_ONLY = process.env['FREE_ONLY'] === '1';

const results: Array<{ id: string; ok: boolean; detail: string }> = [];
const check = (id: string, ok: boolean, detail: string): void => {
  results.push({ id, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};
const section = (t: string): void =>
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`);

const workdir = mkdtempSync(join(tmpdir(), 'spike-0005-'));

// ---------------------------------------------------------------------------
// A1 + A2 — kill the writer mid-flight, then audit
// ---------------------------------------------------------------------------

type KillResult = { acked: string[]; killedAfter: number };

/** Runs the writer and SIGKILLs it once it has acknowledged `killAfter` writes. */
function killWriterAfter(
  dbPath: string,
  requestId: string,
  killAfter: number,
): Promise<KillResult> {
  return new Promise((resolve) => {
    const acked: string[] = [];
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, 'writer.ts'), dbPath, requestId, '600'],
      {
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );

    let buffer = '';
    let killed = false;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('ACK ')) acked.push(line.slice(4));
        if (!killed && acked.length >= killAfter) {
          killed = true;
          // SIGKILL, not SIGTERM. No cleanup handler, no flush, no chance to be
          // tidy — the process simply stops existing.
          child.kill('SIGKILL');
        }
      }
    });

    child.on('exit', () => resolve({ acked, killedAfter: acked.length }));
  });
}

async function durability(): Promise<void> {
  section('A1/A2 — SIGKILL the writer mid-write, then audit the file');

  const rounds = [37, 113, 251, 409];
  let lostTotal = 0;
  let tornTotal = 0;

  for (const killAfter of rounds) {
    const dbPath = join(workdir, `kill-${killAfter}.db`);
    const requestId = `req-${killAfter}`;
    const { acked } = await killWriterAfter(dbPath, requestId, killAfter);

    // Reopen the file exactly as the kernel would at boot.
    const bus = new Bus(dbPath);
    const rows = bus.db
      .prepare('SELECT id, payload_json FROM messages WHERE request_id = ?')
      .all(requestId) as Array<{ id: string; payload_json: string }>;
    const present = new Set(rows.map((r) => r.id));

    const lost = acked.filter((id) => !present.has(id));
    lostTotal += lost.length;

    // A torn write would show up as a payload that will not parse, or one whose
    // contents disagree with its own id.
    let torn = 0;
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload_json) as { seq?: number; nested?: { seq?: number } };
        const seqFromId = Number(r.id.slice(-4));
        if (p.seq !== seqFromId || p.nested?.seq !== seqFromId) torn += 1;
      } catch {
        torn += 1;
      }
    }
    tornTotal += torn;

    console.log(
      `  killed after ${String(acked.length).padStart(3)} acks  ·  on disk ${String(rows.length).padStart(3)}  ·  lost ${lost.length}  ·  torn ${torn}`,
    );
    bus.close();
  }

  check(
    'A1 no acknowledged write lost',
    lostTotal === 0,
    `${lostTotal} lost across ${rounds.length} kills`,
  );
  check(
    'A2 no torn write readable',
    tornTotal === 0,
    `${tornTotal} malformed or inconsistent payloads`,
  );
}

// ---------------------------------------------------------------------------
// A3 + A4 — leases and idempotency
// ---------------------------------------------------------------------------

function leasesAndIdempotency(): void {
  section('A3/A4 — leases reclaimed, effects applied once');

  const dbPath = join(workdir, 'leases.db');
  const bus = new Bus(dbPath);
  for (let i = 0; i < 5; i++) {
    bus.send({
      id: `lease-${i}`,
      requestId: 'req-lease',
      sender: 'worker',
      recipient: 'orchestrator',
      kind: 'report',
      payload: { seq: i },
    });
  }

  // A process takes leases and then dies without finishing.
  const taken = bus.lease('orchestrator', 'dead-process', 50);
  console.log(`  leased by a process that then died   ${taken.length}`);
  bus.close();

  // Restart: a fresh handle on the same file, as the kernel does at boot.
  const rebooted = new Bus(dbPath);
  const before = (
    rebooted.db.prepare(`SELECT count(*) c FROM messages WHERE state='pending'`).get() as {
      c: number;
    }
  ).c;
  // Wait past the lease TTL, then reclaim.
  const waitUntil = Date.now() + 120;
  while (Date.now() < waitUntil) {
    /* spin briefly; the TTL is 50 ms */
  }
  const reclaimed = rebooted.reclaim();
  const after = (
    rebooted.db.prepare(`SELECT count(*) c FROM messages WHERE state='pending'`).get() as {
      c: number;
    }
  ).c;
  console.log(`  pending before reclaim               ${before}`);
  console.log(`  reclaimed on restart                 ${reclaimed}`);
  console.log(`  pending after reclaim                ${after}`);
  check(
    'A3 leases reclaimed on restart',
    reclaimed === 5 && after === 5,
    `${reclaimed} reclaimed, ${after} pending`,
  );

  // A4 — the same message redelivered must have effect exactly once.
  let sideEffects = 0;
  const first = rebooted.applyOnce('lease-0', () => {
    sideEffects += 1;
  });
  const second = rebooted.applyOnce('lease-0', () => {
    sideEffects += 1;
  });
  const third = rebooted.applyOnce('lease-0', () => {
    sideEffects += 1;
  });
  console.log(`  applyOnce results                    ${[first, second, third].join(', ')}`);
  console.log(`  side effects executed                ${sideEffects}`);
  check(
    'A4 no double execution',
    sideEffects === 1 && first && !second && !third,
    `${sideEffects} effect(s) from 3 deliveries`,
  );

  rebooted.close();
}

// ---------------------------------------------------------------------------
// A5 + A6 + A7 — the delivery rules from ADR-0014
// ---------------------------------------------------------------------------

function deliveryRules(): void {
  section('A5/A6/A7 — aggregation, blockers, and the timeout');

  const describe = (r: { deliver: StoredMessage[]; reason: string; missing: number }): string =>
    `${r.deliver.length} delivered · ${r.reason}${r.missing ? ` · ${r.missing} missing` : ''}`;

  // A5 — three teams on one request. Nothing goes until all three are in.
  const bus = new Bus(join(workdir, 'rules.db'));
  bus.openRequest('req-A5', 3, 60_000);
  bus.send({
    id: 'a5-1',
    requestId: 'req-A5',
    sender: 'team1',
    recipient: 'orchestrator',
    kind: 'report',
    payload: { team: 1 },
  });
  const afterOne = bus.readyFor('req-A5');
  console.log(`  after 1 of 3 reports                 ${describe(afterOne)}`);

  bus.send({
    id: 'a5-2',
    requestId: 'req-A5',
    sender: 'team2',
    recipient: 'orchestrator',
    kind: 'report',
    payload: { team: 2 },
  });
  const afterTwo = bus.readyFor('req-A5');
  console.log(`  after 2 of 3 reports                 ${describe(afterTwo)}`);

  bus.send({
    id: 'a5-3',
    requestId: 'req-A5',
    sender: 'team3',
    recipient: 'orchestrator',
    kind: 'report',
    payload: { team: 3 },
  });
  const afterThree = bus.readyFor('req-A5');
  console.log(`  after 3 of 3 reports                 ${describe(afterThree)}`);

  check(
    'A5 held until complete, then together',
    afterOne.deliver.length === 0 &&
      afterTwo.deliver.length === 0 &&
      afterThree.deliver.length === 3,
    `0, 0, then 3 in one delivery`,
  );

  // A6 — a blocker does not wait for its siblings.
  bus.openRequest('req-A6', 3, 60_000);
  bus.send({
    id: 'a6-1',
    requestId: 'req-A6',
    sender: 'team1',
    recipient: 'orchestrator',
    kind: 'report',
    payload: { team: 1 },
  });
  bus.send({
    id: 'a6-2',
    requestId: 'req-A6',
    sender: 'team2',
    recipient: 'orchestrator',
    kind: 'blocker',
    payload: { needs: 'a decision' },
  });
  const withBlocker = bus.readyFor('req-A6');
  console.log(`  one report + one blocker             ${describe(withBlocker)}`);
  check(
    'A6 blocker delivered immediately',
    withBlocker.deliver.length === 1 && withBlocker.deliver[0]?.kind === 'blocker',
    withBlocker.reason,
  );

  // A7 — a stalled sibling must not withhold what the others finished.
  bus.openRequest('req-A7', 3, -1); // deadline already in the past
  bus.send({
    id: 'a7-1',
    requestId: 'req-A7',
    sender: 'team1',
    recipient: 'orchestrator',
    kind: 'report',
    payload: { team: 1 },
  });
  bus.send({
    id: 'a7-2',
    requestId: 'req-A7',
    sender: 'team2',
    recipient: 'orchestrator',
    kind: 'report',
    payload: { team: 2 },
  });
  const timedOut = bus.readyFor('req-A7');
  console.log(`  2 of 3, deadline passed              ${describe(timedOut)}`);
  check(
    'A7 timeout releases a partial set',
    timedOut.deliver.length === 2 && timedOut.missing === 1,
    `${timedOut.deliver.length} delivered, ${timedOut.missing} reported missing`,
  );

  bus.close();
}

// ---------------------------------------------------------------------------
// PART B — two real agents, one structured payload
// ---------------------------------------------------------------------------

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['finding', 'confidence'],
  properties: {
    finding: { type: 'string', maxLength: 200 },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
} as const;

async function askStructured(
  systemPrompt: string,
  prompt: string,
): Promise<{ value: unknown; ms: number; usage: unknown }> {
  const options = {
    model: MODEL,
    systemPrompt,
    tools: [],
    settingSources: [],
    maxTurns: structuredTurnBudget(),
    maxBudgetUsd: budgetCeilingUsd(),
    persistSession: false,
    outputFormat: { type: 'json_schema', schema: REPORT_SCHEMA },
  } as unknown as Options;

  const started = performance.now();
  const q = query({ prompt, options }) as unknown as AsyncGenerator<Record<string, unknown>>;
  let value: unknown = null;
  let usage: unknown;
  for await (const m of q) {
    if (m['type'] === 'result') {
      value = m['structured_output'] ?? null;
      usage = m['modelUsage'];
      break;
    }
  }
  return { value, ms: performance.now() - started, usage };
}

async function realAgents(): Promise<void> {
  section('B — two agents, one structured payload, through the bus');

  const bus = new Bus(join(workdir, 'agents.db'));
  bus.openRequest('req-B', 1, 60_000);

  // An unambiguous instruction. A vague one makes the model ask for
  // clarification instead of answering, which burns the turn budget and looks
  // like a structured-output failure when it is nothing of the sort.
  const producer = await askStructured(
    'You are a research agent. You always answer immediately and never ask for clarification.',
    'State one true mathematical fact about the number 7, and how confident you are.',
  );
  console.log(`  producer turn                        ${producer.ms.toFixed(0)} ms`);
  for (const line of formatUsage(producer.usage)) console.log(line);
  console.log(`  structured payload                   ${JSON.stringify(producer.value)}`);

  const isStructured =
    producer.value !== null &&
    typeof producer.value === 'object' &&
    'finding' in (producer.value as object) &&
    'confidence' in (producer.value as object);

  // Through the bus, as an object rather than prose. This is the difference
  // that ruled out the upstream plain-text transport in ADR-0004.
  const t0 = performance.now();
  bus.send({
    id: 'b-1',
    requestId: 'req-B',
    sender: 'researcher',
    recipient: 'orchestrator',
    kind: 'report',
    payload: producer.value,
  });
  const ready = bus.readyFor('req-B');
  const busMs = performance.now() - t0;

  const received = ready.deliver[0]?.payload as { finding?: string } | undefined;
  console.log(`  bus write + aggregate                ${busMs.toFixed(1)} ms`);
  console.log(`  orchestrator received                ${JSON.stringify(received)?.slice(0, 90)}`);

  const roundTrip = producer.ms + busMs;
  check(
    'B1 structured, not prose',
    isStructured && typeof received?.finding === 'string',
    isStructured ? 'object survived the bus intact' : 'payload was not structured',
  );
  check(
    'B2 round trip measured',
    Number.isFinite(roundTrip),
    `${roundTrip.toFixed(0)} ms total, of which the bus itself is ${busMs.toFixed(1)} ms`,
  );

  bus.close();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  section('environment');
  console.log(`  os              ${osType()} ${arch()}`);
  console.log(`  node            ${process.version}`);
  console.log(`  workdir         ${workdir}`);
  console.log(`  model           ${MODEL}`);
  console.log(`  mode            ${FREE_ONLY ? 'FREE_ONLY — part A only, no AI usage' : 'full'}`);
  if (!FREE_ONLY) console.log(costWarning(1));

  await durability();
  leasesAndIdempotency();
  deliveryRules();
  if (!FREE_ONLY) await realAgents();

  section('summary');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}`);
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(
    failed.length === 0
      ? `  VERDICT: PASS — all ${results.length} criteria met`
      : `  VERDICT: FAIL — ${failed.length} of ${results.length} criteria not met`,
  );
  rmSync(workdir, { recursive: true, force: true });
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nHarness error:', error);
  rmSync(workdir, { recursive: true, force: true });
  process.exit(1);
});

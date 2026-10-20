import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InstanceId, newInstanceId } from '@cortana/core';
import { manualClock, recordingLogger } from '@cortana/core/testing';
import { fakeRunner, TEST_PROFILE } from '@cortana/runner/testing';
import {
  createWriter,
  migrateToLatest,
  openStorage,
  type Storage,
  type Writer,
} from '@cortana/storage';
import { desc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { costSpread, summariseCost } from './costs.ts';
import { auditedRunner } from './recorder.ts';
import { DEFAULT_RETENTION_DAYS, expireAudit } from './retention.ts';
import { auditTurns } from './schema.ts';

let root: string;
let storage: Storage;
let writer: Writer;
let instanceId: InstanceId;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-audit-'));
  storage = openStorage({ dataDir: join(root, 'state') });
  migrateToLatest(storage);
  writer = createWriter({ storage });
  instanceId = newInstanceId();
});

afterEach(() => {
  storage.close();
  rmSync(root, { recursive: true, force: true });
});

const rows = () => storage.db.select().from(auditTurns).orderBy(auditTurns.id).all();
const ANSWER = z.object({ verdict: z.enum(['yes', 'no']) });

describe('the migration this package contributes', () => {
  it('creates its own table through the shared history', () => {
    // The M2 decision in one assertion: the table is declared here, the
    // migration is generated centrally, and there is still one ordered history.
    const tables = (
      storage.connection
        .prepare("select name from sqlite_master where type = 'table' order by name")
        .all() as { name: string }[]
    ).map((row) => row.name);

    expect(tables).toContain('audit_turns');
    expect(tables).toContain('instances');
  });
});

describe('recording a turn', () => {
  it('keeps what was asked and what came back', async () => {
    const runner = auditedRunner(fakeRunner({ text: ['seven is prime'] }), { writer, instanceId });
    const session = await runner.start({
      tier: 'balanced',
      systemPrompt: 'Answer briefly.',
      profile: TEST_PROFILE,
    });

    await session.turn('Is seven prime?');

    const [row] = rows();
    expect(row?.prompt).toBe('Is seven prime?');
    expect(row?.response).toBe('seven is prime');
    expect(row?.outcome).toBe('ok');
    expect(row?.kind).toBe('prose');
    expect(row?.tier).toBe('balanced');
    expect(row?.adapter).toBe('fake');
    expect(row?.sessionId).toBe(session.id);
    expect(row?.instanceId).toBe(instanceId);
  });

  it('hands images to the turn, and records each by its hash rather than its bytes', async () => {
    // The images are passed on, which is the half nothing would notice losing:
    // the port's parameter is optional, so a wrapper that forgot it would still
    // compile and every photo would silently stop at the audit.
    const inner = fakeRunner({ text: ['a red square'] });
    const runner = auditedRunner(inner, { writer, instanceId });
    const session = await runner.start({
      tier: 'balanced',
      systemPrompt: 'Answer briefly.',
      profile: TEST_PROFILE,
    });
    const data = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

    await session.turn('What is this?', [{ mediaType: 'image/jpeg', data }]);

    expect(inner.turns[0]?.images).toEqual([{ mediaType: 'image/jpeg', data }]);
    const [row] = rows();
    expect(row?.prompt).toBe(
      'What is this?\n[image sha256:' +
        createHash('sha256').update(data).digest('hex') +
        ' image/jpeg 7 bytes]',
    );
  });

  it('passes images through a structured session too', async () => {
    const inner = fakeRunner({ values: [{ verdict: 'yes' }] });
    const runner = auditedRunner(inner, { writer, instanceId });
    const session = await runner.startStructured(
      { tier: 'balanced', systemPrompt: 'Answer.', profile: TEST_PROFILE },
      ANSWER,
    );
    const data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

    await session.turn('Is it a PNG?', [{ mediaType: 'image/png', data }]);

    expect(inner.turns[0]?.images).toHaveLength(1);
    expect(rows()[0]?.prompt).toContain('image/png 4 bytes]');
  });

  it('passes on the token that continues a session', async () => {
    // Required by the port, so a wrapper that forgot it would not compile — but
    // a wrapper that answered null would, and every restart would start over.
    const runner = auditedRunner(fakeRunner({ text: ['ok'] }), { writer, instanceId });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

    await session.turn('hello');

    expect(session.resumeToken).toMatch(/^fake-/);
  });

  it('keeps the cache counters beside the cost', async () => {
    // Spike 0009 measured an identical call costing $0.0201 and $0.6891 — 34× —
    // on cache state alone. A cost row without them invites an average, and the
    // average of a 34× spread describes nothing.
    const runner = auditedRunner(
      fakeRunner({
        usage: {
          inputTokens: 1_100,
          outputTokens: 340,
          cacheReadTokens: 107_000,
          cacheWriteTokens: 110_428,
          costUsd: 0.6891,
        },
      }),
      { writer, instanceId },
    );
    const session = await runner.start({ tier: 'deep', systemPrompt: 'a', profile: TEST_PROFILE });
    await session.turn('anything');

    const [row] = rows();
    expect(row?.costUsd).toBeCloseTo(0.6891, 10);
    expect(row?.cacheWriteTokens).toBe(110_428);
    expect(row?.cacheReadTokens).toBe(107_000);
  });

  it('records a null cost as null rather than as free', async () => {
    const runner = auditedRunner(fakeRunner({ usage: { costUsd: null } }), { writer, instanceId });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });
    await session.turn('anything');

    expect(rows()[0]?.costUsd).toBeNull();
  });

  it('stores a structured answer as the value the kernel acted on', async () => {
    const runner = auditedRunner(fakeRunner({ values: [{ verdict: 'yes' }] }), {
      writer,
      instanceId,
    });
    const session = await runner.startStructured(
      { tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE },
      ANSWER,
    );
    await session.turn('Is seven prime?');

    const [row] = rows();
    expect(row?.kind).toBe('structured');
    expect(JSON.parse(row?.response ?? '{}')).toEqual({ verdict: 'yes' });
  });

  it('records the failure and then re-raises it unchanged', async () => {
    // An audit holding only successes cannot answer the question anyone asks it.
    const runner = auditedRunner(fakeRunner({ values: [{ verdict: 'maybe' }] }), {
      writer,
      instanceId,
    });
    const session = await runner.startStructured(
      { tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE },
      ANSWER,
    );

    await expect(session.turn('Is seven prime?')).rejects.toThrow(/schema rejected/);

    const [row] = rows();
    expect(row?.outcome).toBe('failed');
    expect(row?.errorCode).toBe('structured-output-invalid');
    expect(row?.prompt).toBe('Is seven prime?');
    expect(row?.response).toBe('');
  });

  it('writes the record before the caller sees the result', async () => {
    // The ordering is the whole claim: a turn the caller acted on is a turn the
    // database already knows about. Checked by looking at the table from inside
    // the continuation, before anything else runs.
    const runner = auditedRunner(fakeRunner(), { writer, instanceId });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

    let rowsAtReturn = -1;
    await session.turn('anything').then(() => {
      rowsAtReturn = rows().length;
    });

    expect(rowsAtReturn).toBe(1);
  });

  it('measures how long the turn took, on the clock it was given', async () => {
    const clock = manualClock();
    const runner = auditedRunner(fakeRunner(), { writer, instanceId, clock });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

    const turn = session.turn('anything');
    clock.advance(2_400);
    await turn;

    expect(rows()[0]?.durationMs).toBe(2_400);
    expect(rows()[0]?.startedAt).toBe(clock.now() - 2_400);
  });

  it('does not need anyone to remember it exists', async () => {
    // The wrapper is the feature: the runner it wraps has no idea, and neither
    // does the caller.
    const plain = fakeRunner();
    const runner = auditedRunner(plain, { writer, instanceId });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

    await session.turn('one');
    await session.turn('two');

    expect(plain.turns.map((t) => t.prompt)).toEqual(['one', 'two']);
    expect(rows().map((r) => r.prompt)).toEqual(['one', 'two']);
  });

  it('leaves the port’s behaviour alone', async () => {
    const runner = auditedRunner(fakeRunner({ text: ['answered'] }), { writer, instanceId });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

    expect((await session.turn('x')).text).toBe('answered');
    await session.stop();
    expect(session.stopped).toBe(true);
    await expect(session.turn('y')).rejects.toThrow(/stopped/);
  });

  it('raises the turn’s failure even when the record cannot be written', async () => {
    // Losing the record is worth saying so, and not worth replacing the original
    // error with — the caller needs to know its turn failed, not that a write did.
    const logger = recordingLogger();
    const runner = auditedRunner(fakeRunner({ values: [{ verdict: 'maybe' }] }), {
      writer,
      instanceId,
      logger,
    });
    const session = await runner.startStructured(
      { tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE },
      ANSWER,
    );
    await writer.drain();

    await expect(session.turn('anything')).rejects.toThrow(/schema rejected/);
    expect(logger.text()).toContain('could not be recorded');
  });
});

describe('forgetting', () => {
  const dayMs = 86_400_000;

  async function seed(ages: readonly number[], now: number): Promise<void> {
    const runner = auditedRunner(fakeRunner(), { writer, instanceId });
    for (const days of ages) {
      const clock = manualClock(now - days * dayMs);
      const aged = auditedRunner(fakeRunner(), { writer, instanceId, clock });
      const session = await aged.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });
      await session.turn(`${days} days old`);
    }
    void runner;
  }

  it('removes what is past the window and keeps what is not', async () => {
    const now = Date.parse('2026-09-01T12:00:00Z');
    await seed([1, 30, 89, 91, 400], now);
    expect(rows()).toHaveLength(5);

    const report = await expireAudit({ writer, clock: manualClock(now) });

    expect(report.removed).toBe(2);
    expect(
      rows()
        .map((r) => r.prompt)
        .sort(),
    ).toEqual(['1 days old', '30 days old', '89 days old']);
  });

  it('defaults to ninety days', async () => {
    expect(DEFAULT_RETENTION_DAYS).toBe(90);
  });

  it('honours a shorter window', async () => {
    const now = Date.parse('2026-09-01T12:00:00Z');
    await seed([1, 8], now);

    await expireAudit({ writer, retentionDays: 7, clock: manualClock(now) });

    expect(rows().map((r) => r.prompt)).toEqual(['1 days old']);
  });

  it('keeps everything when the window is not a positive number of days', async () => {
    // Zero could be read as "keep nothing", and the difference between an unset
    // value and an instruction to erase the record is not one to infer from a
    // number.
    const now = Date.parse('2026-09-01T12:00:00Z');
    await seed([1, 400], now);
    const logger = recordingLogger();

    const report = await expireAudit({ writer, retentionDays: 0, clock: manualClock(now), logger });

    expect(report.removed).toBe(0);
    expect(rows()).toHaveLength(2);
    expect(logger.text()).toContain('keeping everything');
  });

  it('is quiet when there is nothing to remove', async () => {
    const report = await expireAudit({ writer, clock: manualClock() });
    expect(report.removed).toBe(0);
  });
});

describe('what the table is, stated once', () => {
  it('holds whatever the operator typed, including a credential', async () => {
    // ADR-0019, asserted rather than assumed. Secret keeps a credential out of a
    // log line by closing every route from an object to text; a prompt is not an
    // object being formatted, it is what someone typed. There is no type that
    // helps here, and pretending otherwise would be worse than saying so.
    const runner = auditedRunner(fakeRunner(), { writer, instanceId });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

    await session.turn('my imap password is hunter2, please check the mail');

    expect(rows()[0]?.prompt).toContain('hunter2');
  });

  it('sorts by identifier in the order the turns happened', async () => {
    const runner = auditedRunner(fakeRunner(), { writer, instanceId });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });
    for (const prompt of ['first', 'second', 'third']) await session.turn(prompt);

    const newestFirst = storage.db.select().from(auditTurns).orderBy(desc(auditTurns.id)).all();
    expect(newestFirst.map((r) => r.prompt)).toEqual(['third', 'second', 'first']);
  });
});

describe('what can honestly be said about cost', () => {
  async function record(costs: readonly (number | null)[]): Promise<void> {
    for (const costUsd of costs) {
      const runner = auditedRunner(
        fakeRunner({
          usage: { costUsd, cacheWriteTokens: costUsd && costUsd > 0.5 ? 110_428 : 0 },
        }),
        { writer, instanceId },
      );
      const session = await runner.start({
        tier: 'fast',
        systemPrompt: 'a',
        profile: TEST_PROFILE,
      });
      await session.turn('anything');
    }
  }

  it('adds up what was reported and shows the spread instead of a mean', async () => {
    // Spike 0009 repeated one identical call and measured $0.0201 and $0.6891 —
    // 34× — on prompt-cache state alone, with what selects between the regimes
    // unknown. A mean over that is a number with no referent: it reads as "a
    // turn costs about this", and no turn costs about that.
    await record([0.0201, 0.0212, 0.6891]);

    const summary = summariseCost(storage);
    expect(summary.turns).toBe(3);
    expect(summary.totalUsd).toBeCloseTo(0.7304, 6);
    expect(summary.cheapestUsd).toBeCloseTo(0.0201, 10);
    expect(summary.dearestUsd).toBeCloseTo(0.6891, 10);
    expect(summary).not.toHaveProperty('averageUsd');
  });

  it('makes the spread a number, so it is visible rather than rediscovered', async () => {
    await record([0.0201, 0.6891]);

    expect(costSpread(summariseCost(storage))).toBeCloseTo(34.28, 1);
  });

  it('has no spread to report when nothing reported a cost', async () => {
    await record([null, null]);
    const summary = summariseCost(storage);

    expect(summary.turnsWithoutCost).toBe(2);
    expect(summary.totalUsd).toBe(0);
    expect(costSpread(summary)).toBeNull();
  });

  it('counts what it could not price rather than treating it as free', async () => {
    // The port documents a missing figure as normal, so a total that silently
    // spans fewer turns than it claims would be the misleading part.
    await record([0.05, null, 0.05]);
    const summary = summariseCost(storage);

    expect(summary.turns).toBe(3);
    expect(summary.turnsWithoutCost).toBe(1);
    expect(summary.totalUsd).toBeCloseTo(0.1, 10);
  });

  it('keeps the cache counters that explain the spread', async () => {
    await record([0.0201, 0.6891]);
    const summary = summariseCost(storage);

    expect(summary.cacheWriteTokens).toBe(110_428);
    expect(summary.inputTokens).toBeGreaterThan(0);
  });

  it('counts failures without pricing them', async () => {
    const runner = auditedRunner(fakeRunner({ values: [{ verdict: 'maybe' }] }), {
      writer,
      instanceId,
    });
    const session = await runner.startStructured(
      { tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE },
      ANSWER,
    );
    await expect(session.turn('x')).rejects.toThrow();

    const summary = summariseCost(storage);
    expect(summary.turns).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.turnsWithoutCost).toBe(1);
  });

  it('answers for a window rather than for everything', async () => {
    const now = Date.parse('2026-09-01T12:00:00Z');
    for (const [days, cost] of [
      [10, 0.5],
      [1, 0.25],
    ] as const) {
      const aged = auditedRunner(fakeRunner({ usage: { costUsd: cost } }), {
        writer,
        instanceId,
        clock: manualClock(now - days * 86_400_000),
      });
      const session = await aged.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });
      await session.turn(`${days} days old`);
    }

    const week = summariseCost(storage, { since: new Date(now - 7 * 86_400_000) });
    expect(week.turns).toBe(1);
    expect(week.totalUsd).toBeCloseTo(0.25, 10);
  });

  it('is empty rather than broken when there is nothing to summarise', () => {
    const summary = summariseCost(storage);

    expect(summary.turns).toBe(0);
    expect(summary.totalUsd).toBe(0);
    expect(summary.cheapestUsd).toBeNull();
  });
});

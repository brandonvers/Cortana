/**
 * Spike 0003 — concurrent long-lived agent sessions.
 *
 * Throwaway. See README.md for the pass criteria, written down before this ran.
 *
 * Two things about the design are deliberate and worth knowing before reading:
 *
 * 1. `startup()` spawns the subprocess and completes its initialize handshake
 *    WITHOUT sending a prompt. So the memory question — the one the topology
 *    decision actually rests on — costs nothing at all and scales to any number
 *    of sessions for free. Only the latency questions need model turns, and they
 *    need three of them however many sessions we measure.
 *
 * 2. A turn cannot be read by breaking out of `for await`. Breaking calls the
 *    generator's return(), which ends the session — so a "long-lived" session
 *    measured that way is already dead by the second turn. Each session
 *    therefore runs a background consumer that stays subscribed for the
 *    session's whole life and hands each completed turn back through a promise.
 */

import { execFileSync } from 'node:child_process';
import { arch, cpus, freemem, release, totalmem, type } from 'node:os';
import { readFileSync } from 'node:fs';
import { query, startup, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

const SESSIONS = Number(process.env['SESSIONS'] ?? 5);
const BUDGET_USD = Number(process.env['BUDGET_USD'] ?? 0.5);
const VERBOSE = process.env['VERBOSE'] === '1';

/**
 * A short custom system prompt rather than the full agent preset. Tool
 * definitions dominate a default prompt, and this spike measures process and
 * session behaviour. It is also realistic: every Cortana agent carries its own
 * prompt, so this is the shape a resident agent actually runs with.
 */
const SYSTEM_PROMPT = 'You are a probe. Reply with exactly: ok';
const PROBE = 'ok?';

const baseOptions = (): Options => ({
  model: 'haiku',
  systemPrompt: SYSTEM_PROMPT,
  tools: [],
  settingSources: [],
  maxTurns: 1,
  maxBudgetUsd: BUDGET_USD,
  persistSession: false,
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results: Array<{ id: string; ok: boolean; detail: string }> = [];
const check = (id: string, ok: boolean, detail: string): void => {
  results.push({ id, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
};
const section = (t: string): void =>
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 66 - t.length))}`);
const ms = (n: number): string => (Number.isFinite(n) ? `${n.toFixed(0)} ms` : 'n/a');

// ---------------------------------------------------------------------------
// Process memory
// ---------------------------------------------------------------------------

type Rss = { count: number; totalMb: number; lines: string[] };

function claudeRss(): Rss {
  try {
    const out = execFileSync('ps', ['-eo', 'rss=,args='], { encoding: 'utf8' });
    let count = 0;
    let kb = 0;
    const lines: string[] = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      const args = m?.[2];
      if (!args) continue;
      // The SDK spawns a platform binary from its own optional dependency, so
      // match that path as well as a `claude` on PATH. Exclude our own ps call.
      const isClaude =
        /claude-agent-sdk[^/\s]*\/claude(\s|$)/.test(args) || /(^|\/)claude(\s|$)/.test(args);
      if (!isClaude || /\bps\s+-eo\b/.test(args)) continue;
      count += 1;
      kb += Number(m[1]);
      lines.push(`${(Number(m[1]) / 1024).toFixed(0).padStart(5)} MB  ${args.slice(0, 88)}`);
    }
    return { count, totalMb: kb / 1024, lines };
  } catch {
    return { count: -1, totalMb: Number.NaN, lines: [] };
  }
}

// ---------------------------------------------------------------------------
// A session that survives more than one turn
// ---------------------------------------------------------------------------

type Turn = { firstTokenMs: number; totalMs: number; costUsd: number; models: string };

class PromptStream {
  #queue: SDKUserMessage[] = [];
  #wake: (() => void) | null = null;
  #closed = false;

  push(text: string): void {
    this.#queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as unknown as SDKUserMessage);
    this.#wake?.();
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.#queue.length > 0) yield this.#queue.shift() as SDKUserMessage;
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = () => {
          this.#wake = null;
          resolve();
        };
      });
    }
  }
}

class Session {
  readonly stream = new PromptStream();
  readonly #done: Promise<void>;
  #settle: ((t: Turn) => void) | null = null;
  #started = 0;
  #firstToken = Number.NaN;
  /** total_cost_usd is cumulative per query() call, so report the delta. */
  #lastCumulative = 0;

  constructor(options: Options) {
    const q = query({ prompt: this.stream, options }) as unknown as AsyncGenerator<unknown>;
    this.#done = this.#consume(q);
  }

  async #consume(q: AsyncGenerator<unknown>): Promise<void> {
    try {
      for await (const raw of q as AsyncGenerator<Record<string, unknown>>) {
        if (VERBOSE) console.log(`      · ${String(raw['type'])}`);
        if (raw['type'] === 'assistant' && Number.isNaN(this.#firstToken)) {
          this.#firstToken = performance.now() - this.#started;
        }
        if (raw['type'] === 'result') {
          const cumulative = Number(raw['total_cost_usd'] ?? 0);
          const usage = raw['modelUsage'] as Record<string, unknown> | undefined;
          const turn: Turn = {
            firstTokenMs: this.#firstToken,
            totalMs: performance.now() - this.#started,
            costUsd: Math.max(0, cumulative - this.#lastCumulative),
            models: usage ? Object.keys(usage).join(', ') : 'unknown',
          };
          this.#lastCumulative = cumulative;
          this.#firstToken = Number.NaN;
          const settle = this.#settle;
          this.#settle = null;
          settle?.(turn);
        }
      }
    } catch (error) {
      if (VERBOSE) console.log(`      · consumer ended: ${String(error)}`);
    }
  }

  ask(text: string): Promise<Turn> {
    this.#started = performance.now();
    this.#firstToken = Number.NaN;
    const settled = new Promise<Turn>((resolve) => {
      this.#settle = resolve;
    });
    this.stream.push(text);
    return settled;
  }

  async close(): Promise<void> {
    this.stream.close();
    await Promise.race([this.#done, new Promise((r) => setTimeout(r, 3000))]);
  }
}

/** Reads one turn from a WarmQuery, which is single-use and needs no stream. */
async function readWarmTurn(q: AsyncGenerator<unknown>, started: number): Promise<Turn> {
  let firstTokenMs = Number.NaN;
  for await (const raw of q as AsyncGenerator<Record<string, unknown>>) {
    if (raw['type'] === 'assistant' && Number.isNaN(firstTokenMs)) {
      firstTokenMs = performance.now() - started;
    }
    if (raw['type'] === 'result') {
      const usage = raw['modelUsage'] as Record<string, unknown> | undefined;
      return {
        firstTokenMs,
        totalMs: performance.now() - started,
        costUsd: Number(raw['total_cost_usd'] ?? 0),
        models: usage ? Object.keys(usage).join(', ') : 'unknown',
      };
    }
  }
  return { firstTokenMs, totalMs: performance.now() - started, costUsd: 0, models: 'unknown' };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  section('environment');
  let distro: string;
  try {
    distro = /PRETTY_NAME="?([^"\n]+)"?/.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? '';
  } catch {
    distro = `${type()} ${release()}`;
  }
  const pkgVersion = (name: string): string => {
    try {
      const p = new URL(`./node_modules/${name}/package.json`, import.meta.url);
      return JSON.parse(readFileSync(p, 'utf8')).version;
    } catch {
      return 'unknown';
    }
  };
  console.log(`  os              ${distro}`);
  console.log(`  arch            ${arch()}`);
  console.log(`  cpu             ${cpus()[0]?.model?.trim() ?? '?'} × ${cpus().length}`);
  console.log(
    `  memory          ${(totalmem() / 1024 ** 3).toFixed(1)} GB total, ${(freemem() / 1024 ** 3).toFixed(1)} GB free`,
  );
  console.log(`  node            ${process.version}`);
  console.log(`  agent sdk       ${pkgVersion('@anthropic-ai/claude-agent-sdk')}`);
  console.log(`  sessions        ${SESSIONS}`);

  const baseline = claudeRss();
  console.log(`  baseline        ${baseline.count} claude process(es), ${baseline.totalMb.toFixed(0)} MB`);
  if (VERBOSE) for (const l of baseline.lines) console.log(`                  ${l}`);

  // A machine already short of memory produces timings that say more about
  // swapping than about the thing being measured. Say so loudly rather than
  // letting the numbers be quoted as if they were clean.
  const freeRatio = freemem() / totalmem();
  if (freeRatio < 0.15) {
    console.log('');
    console.log(`  ⚠  WARNING: only ${(freeRatio * 100).toFixed(0)}% of memory is free.`);
    console.log('     Every timing below is distorted by memory pressure and the');
    console.log('     result is not comparable with a run on an idle machine.');
  }

  // -------------------------------------------------------------------------
  // PHASE 1 — memory, for free
  // -------------------------------------------------------------------------
  section(`memory: ${SESSIONS} initialised sessions, no model calls`);
  const warm: Array<Awaited<ReturnType<typeof startup>>> = [];
  for (let i = 0; i < SESSIONS; i++) {
    const t0 = performance.now();
    warm.push(await startup({ options: baseOptions() }));
    console.log(`  session ${String(i + 1).padStart(2)}     initialised in ${ms(performance.now() - t0)}`);
  }

  const loaded = claudeRss();
  if (VERBOSE) for (const l of loaded.lines) console.log(`                  ${l}`);
  const newProcesses = loaded.count - baseline.count;
  const deltaMb = loaded.totalMb - baseline.totalMb;
  const perSession = deltaMb / SESSIONS;
  const totalGb = totalmem() / 1024 ** 3;

  console.log(`  processes       ${loaded.count} total, ${newProcesses} new`);
  console.log(`  total RSS       ${loaded.totalMb.toFixed(0)} MB`);
  console.log(`  attributable    ${deltaMb.toFixed(0)} MB across ${SESSIONS} sessions`);
  console.log(`  per session     ${perSession.toFixed(0)} MB`);
  console.log(`  → 12 residents  ${((perSession * 12) / 1024).toFixed(1)} GB projected`);

  check('1 sessions start', newProcesses >= SESSIONS, `${newProcesses} new for ${SESSIONS} requested`);
  check(
    '2 memory per session',
    Number.isFinite(perSession) && perSession > 0 && (perSession * 12) / 1024 < totalGb / 4,
    `${perSession.toFixed(0)} MB each; 12 → ${((perSession * 12) / 1024).toFixed(1)} GB of ${totalGb.toFixed(0)} GB`,
  );

  // Keep one pre-warmed handle for the wake measurement; discard the rest.
  const forWake = warm.pop();
  for (const w of warm) w.close();
  await new Promise((r) => setTimeout(r, 1000));

  // -------------------------------------------------------------------------
  // PHASE 2 — latency. Three turns total, whatever SESSIONS is.
  // -------------------------------------------------------------------------
  let spent = 0;

  section('cold start, then a second turn on the same session');
  const session = new Session(baseOptions());
  const cold = await session.ask(PROBE);
  spent += cold.costUsd;
  console.log(`  cold turn       first token ${ms(cold.firstTokenMs)}  complete ${ms(cold.totalMs)}`);
  console.log(`  model used      ${cold.models}`);

  const warmTurn = await session.ask(PROBE);
  spent += warmTurn.costUsd;
  console.log(`  warm turn       first token ${ms(warmTurn.firstTokenMs)}  complete ${ms(warmTurn.totalMs)}`);

  check(
    '3 warm beats cold',
    warmTurn.totalMs < cold.totalMs * 0.4,
    `warm ${ms(warmTurn.totalMs)} vs cold ${ms(cold.totalMs)} (need < ${ms(cold.totalMs * 0.4)})`,
  );

  await session.close();

  // -------------------------------------------------------------------------
  section('waking a dormant agent that was pre-warmed');
  let wake: Turn | null = null;
  if (forWake) {
    const t0 = performance.now();
    const wq = forWake.query(PROBE) as unknown as AsyncGenerator<unknown>;
    wake = await readWarmTurn(wq, t0);
    spent += wake.costUsd;
    console.log(`  pre-warmed      first token ${ms(wake.firstTokenMs)}  complete ${ms(wake.totalMs)}`);
    console.log(`  cold reference  ${ms(cold.totalMs)}`);
  }
  check('4 wake under 3 s', (wake?.totalMs ?? Infinity) < 3000, `${ms(wake?.totalMs ?? Number.NaN)} (threshold 3000 ms)`);
  check(
    '5 pre-warming helps',
    (wake?.totalMs ?? Infinity) < cold.totalMs,
    `pre-warmed ${ms(wake?.totalMs ?? Number.NaN)} vs cold ${ms(cold.totalMs)}`,
  );

  // -------------------------------------------------------------------------
  section('cost');
  console.log(`  turns run       3 (independent of SESSIONS — phase 1 sent no prompts)`);
  console.log(`  total spend     $${spent.toFixed(4)}`);
  console.log(`  per turn        $${(spent / 3).toFixed(5)}`);
  check('6 cost measured', Number.isFinite(spent), `$${spent.toFixed(4)} across 3 turns`);

  // -------------------------------------------------------------------------
  section('shutdown');
  const after = claudeRss();
  console.log(`  processes       ${after.count} (baseline was ${baseline.count})`);

  section('summary');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}`);
  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(
    failed.length === 0
      ? `  VERDICT: PASS — all ${results.length} criteria met`
      : `  VERDICT: FAIL — ${failed.length} of ${results.length} criteria not met`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\nHarness error:', error);
  process.exit(1);
});

/**
 * Spike 0013 — can the budget governor see the wall before it hits it?
 *
 * The outstanding list carried "provider usage-limit behaviour under load" from
 * the beginning, and it was left last because the obvious way to answer it is to
 * exhaust the subscription and watch what breaks — which would lock the operator
 * out of their own tooling for the rest of the window.
 *
 * The SDK turns out to expose the numbers directly: per-window `utilization` and
 * `resets_at`, plus a push event when the rate-limit state changes. If those are
 * live and fine-grained, the governor never needs to approach the limit. If they
 * are stale or coarse, that is equally decisive and much cheaper to learn.
 *
 * What happens AT the wall is deliberately out of scope, and the report says so
 * rather than implying this closed it.
 */

import { type Options, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { budgetCeilingUsd, costWarning, MODEL } from '../model.ts';

const TURNS = Number(process.env['TURNS'] ?? 4);

/** Enough work to move a meter, cheap enough not to matter. */
const WORK_PROMPTS = [
  'List five common causes of flaky tests in CI, one line each.',
  'Name five HTTP status codes in the 4xx range and what each means, one line each.',
  'Give five rules of thumb for sizing a database connection pool, one line each.',
  'List five signs that a function should be split up, one line each.',
  'Name five common causes of memory growth in long-running Node processes.',
  'List five things worth logging around an outbound HTTP call, one line each.',
];

/** A queue-backed prompt stream: control requests need streaming input. */
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

type Window = { utilization: number | null; resets_at: string | null } | null | undefined;
type Reading = {
  label: string;
  available: boolean;
  subscription: string | null;
  windows: Record<string, Window>;
  sessionCostUsd: number | null;
  raw: string;
};

type RateLimitEvent = {
  status?: string;
  utilization?: number;
  rateLimitType?: string;
  resetsAt?: number;
};

function readWindows(payload: Record<string, unknown>): Record<string, Window> {
  const limits = (payload['rate_limits'] ?? null) as Record<string, unknown> | null;
  if (!limits) return {};
  const out: Record<string, Window> = {};
  for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet']) {
    out[key] = limits[key] as Window;
  }
  return out;
}

function describe(r: Reading): void {
  console.log(`  ${r.label}: available=${r.available} subscription=${r.subscription ?? '(none)'}`);
  for (const [name, w] of Object.entries(r.windows)) {
    if (!w) continue;
    console.log(
      `    ${name.padEnd(18)} utilization=${w.utilization ?? 'null'}  resets_at=${w.resets_at ?? 'null'}`,
    );
  }
  if (r.sessionCostUsd !== null) console.log(`    session cost so far: $${r.sessionCostUsd}`);
}

async function main(): Promise<void> {
  console.log(costWarning(TURNS));

  const stream = new PromptStream();
  const options = {
    model: MODEL,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    persistSession: false,
    tools: [],
    maxTurns: 2,
    maxBudgetUsd: budgetCeilingUsd(),
  } as unknown as Options;

  const q = query({ prompt: stream, options }) as unknown as AsyncGenerator<
    Record<string, unknown>
  > & {
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<
      Record<string, unknown>
    >;
  };

  const events: RateLimitEvent[] = [];
  const turnCosts: number[] = [];
  let turnsSeen = 0;
  let settle: (() => void) | null = null;

  const consume = (async () => {
    for await (const message of q) {
      if (message['type'] === 'rate_limit_event') {
        events.push((message['rate_limit_info'] ?? {}) as RateLimitEvent);
      }
      if (message['type'] === 'result') {
        turnCosts.push(Number(message['total_cost_usd'] ?? 0));
        turnsSeen++;
        settle?.();
      }
    }
  })();

  const nextTurn = async (text: string): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      settle = () => {
        settle = null;
        resolve();
      };
    });
    stream.push(text);
    await done;
  };

  /**
   * The method name is the SDK's own stability warning. A kernel that reads this
   * must tolerate its absence, so the harness treats a missing method as a
   * result rather than a crash.
   */
  const read = async (label: string): Promise<Reading | null> => {
    const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== 'function') {
      console.log(`  ${label}: the usage method is not present on this SDK build`);
      return null;
    }
    try {
      const payload = await fn.call(q);
      const cost = payload['session_cost'] as Record<string, unknown> | undefined;
      const reading: Reading = {
        label,
        available: payload['rate_limits_available'] === true,
        subscription: (payload['subscription_type'] ?? null) as string | null,
        windows: readWindows(payload),
        sessionCostUsd:
          cost && typeof cost['total_cost_usd'] === 'number'
            ? (cost['total_cost_usd'] as number)
            : null,
        raw: JSON.stringify(payload).slice(0, 400),
      };
      describe(reading);
      return reading;
    } catch (err) {
      console.log(`  ${label}: the usage call threw — ${String(err).slice(0, 160)}`);
      return null;
    }
  };

  // The session must be live before a control request can be answered, so one
  // turn runs first and the baseline is taken after it.
  console.log('\n--- warming the session ---');
  await nextTurn('Reply with the single word: ready.');

  console.log('\n--- baseline ---');
  const before = await read('before');

  console.log(`\n--- ${TURNS} turns of work ---`);
  for (let i = 0; i < TURNS; i++) {
    await nextTurn(WORK_PROMPTS[i % WORK_PROMPTS.length] as string);
    process.stdout.write(`  turn ${i + 1}/${TURNS}\r`);
  }
  console.log('');

  console.log('\n--- after ---');
  const after = await read('after');

  stream.close();
  await consume;

  console.log('\n--- criteria ---');
  if (!before || !after) {
    console.log('  E0 telemetry        VOID — no reading was obtained; nothing below applies');
    return;
  }

  console.log(
    `  E0 telemetry        ${before.available ? `ok — available, subscription=${before.subscription ?? 'unreported'}` : 'ABSENT — rate_limits_available is false on this account'}`,
  );
  if (!before.available) {
    console.log('      E1–E3 suppressed: there are no windows to read.');
  } else {
    const fh = before.windows['five_hour'];
    const usable = fh && typeof fh.utilization === 'number' && !!fh.resets_at;
    console.log(
      `  E1 usable numbers   ${usable ? 'ok — five_hour carries a utilization and a reset time' : 'FAILED — five_hour is missing a utilization or a reset time'}`,
    );

    // The decisive one. A number that does not move cannot be steered on, and
    // "stale" and "too coarse" imply different designs — so the delta is printed
    // rather than only its verdict.
    for (const name of Object.keys(before.windows)) {
      const a = before.windows[name];
      const b = after.windows[name];
      if (!a || !b) continue;
      const from = a.utilization;
      const to = b.utilization;
      const moved = typeof from === 'number' && typeof to === 'number' && to !== from;
      console.log(
        `  E2 ${name.padEnd(18)} ${from ?? 'null'} -> ${to ?? 'null'}  ${moved ? `MOVED by ${(Number(to) - Number(from)).toFixed(4)}` : 'unchanged'}`,
      );
    }

    const resetStable = Object.keys(before.windows).every((name) => {
      const a = before.windows[name];
      const b = after.windows[name];
      return !a || !b || a.resets_at === b.resets_at;
    });
    console.log(
      `  E3 reset stability  ${resetStable ? 'ok — reset times identical across both reads' : 'the reset time changed between reads within one run'}`,
    );
  }

  console.log(
    `  E4 push channel     ${
      events.length
        ? `${events.length} rate_limit_event(s): ${JSON.stringify(events).slice(0, 200)}`
        : 'not observed — no rate_limit_event arrived in this run (not evidence it does not work)'
    }`,
  );

  const summed = turnCosts.length ? (turnCosts.at(-1) ?? 0) : 0;
  console.log(
    `  E5 cost agreement   endpoint=$${after.sessionCostUsd ?? 'n/a'}  result messages=$${summed.toFixed(4)}` +
      ` across ${turnsSeen} turn(s)`,
  );
  console.log(
    '\nNot measured, by design: what the kernel sees AT the limit. The typings say an\n' +
      "assistant message can carry error: 'rate_limit' and that the rate-limit status can\n" +
      'be `rejected`. Both remain documented rather than observed.',
  );
}

await main();

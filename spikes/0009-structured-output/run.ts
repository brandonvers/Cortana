/**
 * Spike 0009 — is structured output enforced, and what does the kernel see when
 * it is not?
 *
 * Throwaway. See README.md for the pass criteria, written down before this ran.
 * **Consumes AI usage.**
 *
 * [ADR-0015](../../docs/adr/0015-structured-output-at-the-model-boundary.md)
 * already requires Zod re-validation regardless, so this is not asking whether to
 * validate. It asks what the failure path looks like, since the ADR calls it "a
 * handled error path, not an exception" and nothing has ever exercised it.
 *
 * Three lessons from earlier spikes are built in rather than rediscovered:
 *
 * - **A control that proves the mechanism was engaged.** Compliance with a schema
 *   is not evidence the schema did anything; the same prompt runs without one.
 *   Spike 0007 crowned a winner on a test with no headroom for want of this.
 * - **Every probe survives its own failure.** A query ending in an error result
 *   throws rather than yielding one, and in spike 0008 that killed a whole run
 *   and lost five criteria.
 * - **`modelUsage` rather than `usage`.** The SDK documents the former as
 *   covering every model call including internal ones, which is where silent
 *   structured-output retries would show up.
 */

import { readFileSync } from 'node:fs';
import { arch, cpus, release, totalmem, type } from 'node:os';
import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { budgetCeilingUsd, MODEL, type Tier } from '../model.ts';

const WITH_OPUS = process.env['WITH_OPUS'] === '1';

const results: Array<{ id: string; ok: boolean; detail: string }> = [];
function check(id: string, ok: boolean, detail: string): void {
  results.push({ id, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id} — ${detail}`);
}
/** Recorded, never scored — for questions with no honest pass mark in advance. */
function observe(id: string, detail: string): void {
  console.log(`  NOTE  ${id} — ${detail}`);
}
function section(title: string): void {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ---------------------------------------------------------------------------
section('environment');
console.log(`  OS              ${type()} ${release()} ${arch()}`);
console.log(`  CPU             ${cpus()[0]?.model.trim()} × ${cpus().length}`);
console.log(`  memory          ${(totalmem() / 1e9).toFixed(1)} GB`);
console.log(`  Node.js         ${process.version}`);
console.log(
  `  Agent SDK       ${JSON.parse(readFileSync('./package.json', 'utf8')).dependencies['@anthropic-ai/claude-agent-sdk']}`,
);
console.log(`  model           ${MODEL}${WITH_OPUS ? ' (+ opus for criterion 6)' : ''}`);

// ---------------------------------------------------------------------------
/**
 * The cases. Each strains compliance in a different way, and `easy` is the
 * control that says the mechanism works at all.
 */
type Case = {
  key: string;
  prompt: string;
  schema: Record<string, unknown> | undefined;
  strains: string;
};

const EASY_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

const CASES: Case[] = [
  {
    key: 'easy',
    prompt: 'What is the capital of Hungary? Answer briefly.',
    schema: EASY_SCHEMA,
    strains: 'nothing — the control',
  },
  {
    key: 'no-schema',
    prompt: 'What is the capital of Hungary? Answer briefly.',
    schema: undefined,
    strains: 'the control for criterion 1: same prompt, no schema',
  },
  {
    key: 'impossible-enum',
    prompt: 'What colour is the number seven? Answer using the schema. Do not explain.',
    schema: {
      type: 'object',
      properties: { colour: { type: 'string', enum: ['red', 'green', 'blue'] } },
      required: ['colour'],
      additionalProperties: false,
    },
    strains: 'no valid value exists',
  },
  {
    key: 'unsupplied-field',
    prompt:
      'In one sentence, state the boiling point of water at sea level. You have no documents, no web access and no sources.',
    schema: {
      type: 'object',
      properties: {
        answer: { type: 'string' },
        sourceUrl: { type: 'string', format: 'uri' },
      },
      required: ['answer', 'sourceUrl'],
      additionalProperties: false,
    },
    strains: 'FABRICATION — a required field the content cannot supply',
  },
  {
    key: 'closed-object',
    prompt:
      'Budapest is the capital of Hungary, has about 1.7 million residents, sits on the Danube, and was formed in 1873 from Buda, Pest and Óbuda. Report what you know using the schema.',
    schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
    strains: 'the temptation to add fields the schema forbids',
  },
  {
    key: 'deep-nesting',
    prompt: 'Describe Hungary using the schema. Invent nothing you do not know.',
    schema: {
      type: 'object',
      properties: {
        country: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            regions: {
              type: 'array',
              minItems: 3,
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  cities: {
                    type: 'array',
                    minItems: 2,
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        founded: { type: ['integer', 'null'] },
                      },
                      required: ['name', 'founded'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['name', 'cities'],
                additionalProperties: false,
              },
            },
          },
          required: ['name', 'regions'],
          additionalProperties: false,
        },
      },
      required: ['country'],
      additionalProperties: false,
    },
    strains: 'structural difficulty rather than semantic',
  },
];

// ---------------------------------------------------------------------------
type Outcome = {
  key: string;
  model: string;
  subtype: string;
  terminalReason: string;
  structured: unknown;
  hasStructured: boolean;
  text: string;
  costUsd: number;
  modelCalls: number;
  outputTokens: number;
  durationMs: number;
  failure: string;
};

/**
 * Runs one case and returns everything needed to explain the outcome.
 *
 * `modelUsage` is summed rather than `usage`: the SDK documents the former as
 * covering every model call made through the pipeline **including internal
 * ones**, which is exactly where a silent structured-output retry would appear.
 */
async function runCase(c: Case, model: string, maxTurns: number): Promise<Outcome> {
  const started = performance.now();
  const out: Outcome = {
    key: c.key,
    model,
    subtype: 'none',
    terminalReason: '',
    structured: undefined,
    hasStructured: false,
    text: '',
    costUsd: 0,
    modelCalls: 0,
    outputTokens: 0,
    durationMs: 0,
    failure: '',
  };
  const texts: string[] = [];
  const options = {
    model,
    maxTurns,
    maxBudgetUsd: budgetCeilingUsd(model as Tier),
    systemPrompt: 'You are a probe. Answer the question you are given.',
    tools: [],
    settingSources: [],
    persistSession: false,
    ...(c.schema ? { outputFormat: { type: 'json_schema', schema: c.schema } } : {}),
  } as unknown as Options;

  // Every probe survives its own failure — spike 0008 lost five criteria to an
  // unguarded loop.
  try {
    for await (const message of query({ prompt: c.prompt, options })) {
      const m = message as {
        type?: string;
        subtype?: string;
        terminal_reason?: string;
        structured_output?: unknown;
        total_cost_usd?: number;
        modelUsage?: Record<string, { outputTokens?: number; webSearchRequests?: number }>;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && block.text) texts.push(block.text.trim());
        }
      }
      if (m.type === 'result') {
        out.subtype = m.subtype ?? 'ok';
        out.terminalReason = m.terminal_reason ?? '';
        out.structured = m.structured_output;
        out.hasStructured = m.structured_output !== undefined;
        out.costUsd = m.total_cost_usd ?? 0;
        const usage = m.modelUsage ?? {};
        out.modelCalls = Object.keys(usage).length;
        out.outputTokens = Object.values(usage).reduce((s, u) => s + (u.outputTokens ?? 0), 0);
      }
    }
  } catch (error) {
    out.failure = String(error).split('\n')[0]?.slice(0, 180) ?? 'unknown';
    out.subtype = 'threw';
  }
  out.text = texts.join(' ').replace(/\s+/g, ' ').slice(0, 300);
  out.durationMs = performance.now() - started;
  return out;
}

function describe(o: Outcome): void {
  console.log(
    `    ${o.key.padEnd(17)} ${o.model.padEnd(7)} subtype=${o.subtype.padEnd(34)} structured=${o.hasStructured ? 'yes' : 'NO '} $${o.costUsd.toFixed(4)} ${o.outputTokens} out-tok ${(o.durationMs / 1000).toFixed(1)}s`,
  );
  if (o.terminalReason) console.log(`      terminal_reason: ${o.terminalReason}`);
  if (o.failure) console.log(`      threw: ${o.failure}`);
  if (o.hasStructured) {
    console.log(`      structured: ${JSON.stringify(o.structured).slice(0, 260)}`);
  } else if (o.text) {
    console.log(`      text: "${o.text.slice(0, 200)}"`);
  }
}

// ---------------------------------------------------------------------------
section(`cases on ${MODEL}`);
const outcomes: Outcome[] = [];
for (const c of CASES) {
  console.log(`\n  ${c.key} — strains: ${c.strains}`);
  const o = await runCase(c, MODEL, 3);
  outcomes.push(o);
  describe(o);
}

const by = (key: string): Outcome | undefined => outcomes.find((o) => o.key === key);
const easy = by('easy');
const noSchema = by('no-schema');

// ---------------------------------------------------------------------------
section('criteria');

check(
  '0 an easy schema returns valid structured output',
  Boolean(easy?.hasStructured),
  easy?.hasStructured
    ? `structured_output present: ${JSON.stringify(easy.structured).slice(0, 120)}`
    : `absent (subtype ${easy?.subtype})`,
);

// Compliance is not evidence. Without this control, a well-shaped answer says
// nothing about whether the schema constrained anything.
const schemaDidWork = Boolean(easy?.hasStructured) && !noSchema?.hasStructured;
check(
  '1 the schema is doing the work, not the question',
  schemaDidWork,
  `with schema: structured=${easy?.hasStructured ? 'yes' : 'no'}; without: structured=${noSchema?.hasStructured ? 'yes' : 'no'}, answered in text ("${noSchema?.text.slice(0, 60)}…")`,
);

// The failure path ADR-0015 calls "handled" and nothing has exercised.
const hardCases = outcomes.filter((o) => o.key !== 'easy' && o.key !== 'no-schema');
const retryExhausted = hardCases.filter(
  (o) =>
    o.subtype === 'error_max_structured_output_retries' ||
    o.terminalReason === 'structured_output_retry_exhausted',
);
if (retryExhausted.length > 0) {
  check(
    '2 the failure path is reachable',
    true,
    `${retryExhausted.length} case(s) exhausted structured-output retries: ${retryExhausted.map((o) => o.key).join(', ')}`,
  );
  for (const o of retryExhausted) {
    observe(
      `3 what the kernel receives when ${o.key} fails`,
      `structured_output ${o.hasStructured ? `present: ${JSON.stringify(o.structured).slice(0, 140)}` : 'ABSENT'}; terminal_reason=${o.terminalReason || 'none'}`,
    );
  }
} else {
  observe(
    '2 the failure path is reachable',
    `NOT REACHED — no adversarial case exhausted retries. Every hard case returned: ${hardCases.map((o) => `${o.key}=${o.subtype}${o.hasStructured ? '/structured' : '/no-structured'}`).join(', ')}. This is a finding about how hard the schema is to break, not a pass.`,
  );
}

// The hypothesis about ADR-0015's unexplained 70x cost spread: silent retries.
const hardest = hardCases.reduce<Outcome | undefined>(
  (worst, o) => (!worst || o.costUsd > worst.costUsd ? o : worst),
  undefined,
);
if (easy && hardest) {
  const ratio = easy.costUsd > 0 ? hardest.costUsd / easy.costUsd : Number.NaN;
  observe(
    '4 does a hard schema cost more than an easy one',
    `easy $${easy.costUsd.toFixed(4)} (${easy.outputTokens} out-tok) vs ${hardest.key} $${hardest.costUsd.toFixed(4)} (${hardest.outputTokens} out-tok) = ${Number.isFinite(ratio) ? `${ratio.toFixed(1)}×` : 'n/a'}. ADR-0015 recorded an unexplained 70× spread on one model; a large ratio here supports silent retries as the cause, a small one does not.`,
  );
}

// The one with consequences for the kernel: schema-valid and false.
const fabricated = by('unsupplied-field');
if (fabricated) {
  const value = JSON.stringify(fabricated.structured);
  const invented = /https?:\/\//.test(value);
  observe(
    '5 fabrication under a required field',
    fabricated.hasStructured
      ? invented
        ? `INVENTED A URL — the response is schema-valid and false, which Zod re-validation cannot catch: ${value.slice(0, 180)}`
        : `returned structured output without a real URL: ${value.slice(0, 180)}`
      : `no structured output; subtype=${fabricated.subtype}`,
  );
}

// ---------------------------------------------------------------------------
if (WITH_OPUS) {
  section('criterion 6 — the opus row ADR-0015 left empty');
  const o = await runCase(CASES[0] as Case, 'opus', 1);
  describe(o);
  observe(
    '6 opus carrier turn at maxTurns: 1',
    o.hasStructured
      ? 'succeeds in one turn, like sonnet'
      : `fails at one turn (subtype ${o.subtype}), like haiku — a downgrade to opus-with-tight-budget has the same trap`,
  );
} else {
  console.log('\n  criterion 6 skipped (WITH_OPUS=1 to fill ADR-0015’s empty row).');
}

// ---------------------------------------------------------------------------
section('cost');
const spent = outcomes.reduce((s, o) => s + o.costUsd, 0);
console.log(`  total           $${spent.toFixed(4)} across ${outcomes.length} case(s)`);
for (const o of outcomes) {
  console.log(`    ${o.key.padEnd(17)} $${o.costUsd.toFixed(4)}`);
}
section('summary');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}`);
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(
  failed.length === 0
    ? `  VERDICT: PASS — all ${results.length} scored criteria met`
    : `  VERDICT: FAIL — ${failed.length} of ${results.length} scored criteria not met`,
);
console.log('  Criteria 3, 4, 5 and 6 are recorded, not scored. See README.');
process.exit(failed.length === 0 ? 0 : 1);

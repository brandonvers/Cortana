/**
 * Spike 0006 — does fused lexical + vector retrieval actually work on a language
 * the stemmer does not cover, and which embedding model should be the default?
 *
 * Throwaway. See README.md for the pass criteria, written down before this ran.
 *
 * **This spike consumes no AI usage.** Everything runs against a local Ollama.
 * The cost is disk, VRAM and wall-clock.
 *
 * Two decisions rest on it:
 *
 * - [ADR-0012](../../docs/adr/0012-local-embeddings.md) says the default embedding
 *   model is "chosen from measurement rather than reputation". This is that
 *   measurement. Reputation is measured too, as a control: the candidate list
 *   includes a model whose own card does not list Hungarian, because ADR-0012's
 *   stated fear is silent degradation and an unproven fear is a guess.
 * - [ADR-0010](../../docs/adr/0010-sqlite-storage.md) carries two lexical indexes
 *   plus a vector index. That complexity is only justified if fusing them beats
 *   every part alone. Criterion 5 is allowed to say it does not.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { arch, cpus, freemem, release, totalmem, type } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { type Dataset, type Mechanism, PUBLIC_DATASET, validate } from './dataset.ts';

const OLLAMA = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434';

/**
 * The candidates, and why each is here. Licence matters as much as score: the
 * project is MIT and steers every user into whatever it defaults to, so a model
 * under non-OSI terms is not a neutral default even though the user pulls it
 * themselves.
 */
type Candidate = {
  model: string;
  licence: string;
  note: string;
  /**
   * Prefix applied to the **query** only, never to the stored item.
   *
   * Instruction-tuned embedding models are asymmetric: they expect a task
   * description on the query side and a bare document on the other. Qwen3's own
   * card puts the cost of omitting it at 1–5% of retrieval performance.
   *
   * The first run of this spike embedded queries and documents identically for
   * every model, which quietly handicapped the one model that asks for
   * something different. A comparison that penalises a model for how it is meant
   * to be called is measuring the harness, not the model.
   */
  queryPrefix?: string;
};

const CANDIDATES: Candidate[] = [
  {
    model: 'bge-m3',
    licence: 'MIT',
    note: '567M, 8k context, 100+ languages. The reference multilingual model.',
  },
  {
    model: 'qwen3-embedding:0.6b',
    licence: 'Apache-2.0',
    note: 'Top multilingual MTEB per parameter; output dimension is configurable.',
    queryPrefix:
      'Instruct: Given a question from the owner of a personal assistant, retrieve the stored memory that answers it\nQuery:',
  },
  {
    model: 'nomic-embed-text-v2-moe',
    licence: 'Apache-2.0',
    note: 'Mixture-of-experts, ~100 languages, fewer active parameters per token.',
  },
  {
    model: 'paraphrase-multilingual',
    licence: 'Apache-2.0',
    note: '278M. The small end — what a CPU-only or 2 GB-VRAM machine can afford.',
  },
  {
    model: 'granite-embedding:278m',
    licence: 'Apache-2.0',
    note: 'CONTROL, expected to lose: called multilingual, but its card lists 12 languages and Hungarian is not one of them.',
  },
  {
    model: 'nomic-embed-text',
    licence: 'Apache-2.0',
    note: 'CONTROL, expected to lose: English-first, and by pull count the model most people reach for by default.',
  },
  {
    model: 'embeddinggemma',
    licence: 'Gemma Terms — NOT OSI',
    note: 'Measured on request. Scores well, but its licence carries use restrictions and downstream obligations that MIT and Apache-2.0 do not, so it cannot be the default whatever this table says.',
  },
];

/**
 * A control that is not a model: deterministic vectors derived from a hash of the
 * text, carrying no meaning whatsoever.
 *
 * It is here because a dry run against a stub server exposed a hole in criterion
 * 5. "Fusion beats either half alone" **passed on random vectors** — fusing a
 * meaningless ranked list into a good one perturbs the order enough to move
 * recall by a query or two, in whichever direction chance takes it. A criterion
 * that a random number generator can satisfy is not evidence for the two-index
 * design.
 *
 * So every run measures the noise floor, and a real model has to beat *that*, not
 * merely beat its own halves. It costs nothing: no model, no Ollama call.
 */
const RANDOM_CONTROL = 'random-vectors (control)';
const RANDOM_DIMS = 768;

function randomVector(text: string): number[] {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
  return Array.from({ length: RANDOM_DIMS }, () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    return ((h >>> 0) / 4294967296) * 2 - 1;
  });
}

/** `MODELS=bge-m3,qwen3-embedding:0.6b` to run a subset. */
const SELECTED = process.env['MODELS']
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Reciprocal-rank-fusion constant. 60 is the value from the original paper. */
const RRF_K = 60;

/** Retrieval depth. Recall is reported at 1 and 5; MRR is computed over this. */
const DEPTH = 10;

const results: Array<{ id: string; ok: boolean; detail: string }> = [];
function check(id: string, ok: boolean, detail: string): void {
  results.push({ id, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id} — ${detail}`);
}
function section(title: string): void {
  console.log(`\n─── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

// ---------------------------------------------------------------------------
section('environment');
console.log(`  OS              ${type()} ${release()} ${arch()}`);
console.log(`  CPU             ${cpus()[0]?.model.trim()} × ${cpus().length}`);
console.log(
  `  memory          ${(totalmem() / 1e9).toFixed(1)} GB total, ${(freemem() / 1e9).toFixed(1)} GB free`,
);
console.log(`  Node.js         ${process.version}`);
console.log(
  `  better-sqlite3  ${JSON.parse(readFileSync('./package.json', 'utf8')).dependencies['better-sqlite3']}`,
);
console.log(`  ollama at       ${OLLAMA}`);

/**
 * Whether the GPU is actually being used, which the container's configuration
 * decides rather than the host's. A Docker Ollama without `--gpus` runs on CPU
 * and says nothing about it — the numbers below would then be CPU numbers
 * labelled as if the card were involved.
 */
try {
  const smi = execFileSync(
    'nvidia-smi',
    ['--query-gpu=name,memory.total', '--format=csv,noheader'],
    {
      stdio: 'pipe',
    },
  )
    .toString()
    .trim();
  console.log(`  host GPU        ${smi}`);
} catch {
  console.log('  host GPU        none visible to this process');
}

// ---------------------------------------------------------------------------
section('dataset');

let dataset: Dataset = PUBLIC_DATASET;
const datasetPath = process.env['DATASET'];
if (datasetPath) {
  // The private set of real material. Kept outside the repository on purpose —
  // it is the authoritative number for choosing a default, and it is also
  // somebody's actual life.
  dataset = JSON.parse(readFileSync(datasetPath, 'utf8')) as Dataset;
  dataset.name = `private (${datasetPath})`;
}

const problems = validate(dataset);
for (const p of problems) console.log(`  PROBLEM  ${p}`);
console.log(`  set             ${dataset.name}`);
console.log(`  items           ${dataset.items.length}`);
console.log(`  queries         ${dataset.queries.length}`);
check('0 dataset is coherent', problems.length === 0, `${problems.length} problem(s)`);
if (problems.length > 0) {
  console.log('\n  Refusing to measure against a broken test set.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
section('ollama');

type EmbedResult = { embeddings: number[][] };

async function embed(model: string, input: string[]): Promise<number[][]> {
  const response = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const body = (await response.json()) as EmbedResult;
  if (!Array.isArray(body.embeddings) || body.embeddings.length !== input.length) {
    throw new Error(`expected ${input.length} embeddings, got ${body.embeddings?.length}`);
  }
  return body.embeddings;
}

let installed: string[] = [];
try {
  const tags = (await (await fetch(`${OLLAMA}/api/tags`)).json()) as {
    models: Array<{ name: string }>;
  };
  installed = tags.models.map((m) => m.name);
  console.log(`  reachable       yes, ${installed.length} model(s) installed`);
} catch (error) {
  console.log(`  reachable       NO — ${String(error)}`);
  check('1 ollama reachable', false, `cannot reach ${OLLAMA}`);
  console.log('\n  Set OLLAMA_URL if it is not on the default port.');
  process.exit(1);
}
check('1 ollama reachable', true, `${OLLAMA}, ${installed.length} model(s)`);

/** A model counts as present under either its bare name or an explicit :latest. */
const present = (m: string): boolean =>
  installed.some((i) => i === m || i === `${m}:latest` || i.replace(/:latest$/, '') === m);

const candidates = CANDIDATES.filter((c) => !SELECTED || SELECTED.includes(c.model));
const missing = candidates.filter((c) => !present(c.model));
const runnable = candidates.filter((c) => present(c.model));

for (const c of candidates) {
  console.log(
    `  ${present(c.model) ? '✓' : '✗'} ${c.model.padEnd(26)} ${c.licence.padEnd(12)} ${c.note}`,
  );
}
if (missing.length > 0) {
  console.log('\n  Missing. Pull them, then re-run:');
  for (const c of missing) console.log(`    ollama pull ${c.model}`);
}
// Two models are required for a comparison, which is what an unnarrowed run is.
// A run narrowed with MODELS= is asking a different question — usually about one
// model's latency — and refusing it there was a rule applied past its purpose.
// The random control is always present, so there is never nothing to read against.
const NARROWED = Boolean(SELECTED?.length);
check(
  '2 candidate models available',
  runnable.length >= (NARROWED ? 1 : 2),
  NARROWED
    ? `${runnable.length} of ${candidates.length} selected via MODELS= (narrowed run: comparison criteria are not decisive)`
    : `${runnable.length} of ${candidates.length} present (a comparison needs at least two)`,
);
if (runnable.length < (NARROWED ? 1 : 2)) process.exit(1);
if (NARROWED) {
  console.log('  NOTE: MODELS= is set. This run measures the selected model(s); it cannot');
  console.log('        choose a default, and criteria 5-7 should be read as informational.');
}

// ---------------------------------------------------------------------------
section('lexical indexes');

const db = new Database(':memory:');
sqliteVec.load(db);
console.log(`  sqlite          ${db.prepare('select sqlite_version() v').get().v}`);
console.log(`  sqlite-vec      ${db.prepare('select vec_version() v').get().v}`);

// The two-index design from ADR-0010: unicode61 folds diacritics so unaccented
// typing matches accented text, and trigram matches substrings so an inflected or
// compounded form still hits. Neither alone is enough for an unstemmed language.
db.exec('create virtual table lex using fts5(body, tokenize = "unicode61 remove_diacritics 2")');
db.exec('create virtual table tri using fts5(body, tokenize = "trigram")');
const insertLex = db.prepare('insert into lex(rowid, body) values (?, ?)');
const insertTri = db.prepare('insert into tri(rowid, body) values (?, ?)');
for (const item of dataset.items) {
  insertLex.run(item.id, item.text);
  insertTri.run(item.id, item.text);
}
console.log(`  indexed         ${dataset.items.length} items into both lexical indexes`);

/**
 * FTS5 defaults to AND across a bare multi-word query, which on a natural-language
 * question means almost nothing ever matches. Tokens are therefore OR-ed, and
 * ranking does the discriminating. Tokens shorter than three characters are
 * dropped because the trigram tokenizer cannot match them at all.
 */
function ftsQuery(q: string): string {
  const tokens = q
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

function lexicalSearch(table: 'lex' | 'tri', q: string): number[] {
  const match = ftsQuery(q);
  if (!match) return [];
  try {
    return db
      .prepare(
        `select rowid as id from ${table} where ${table} match ? order by bm25(${table}) limit ?`,
      )
      .all(match, DEPTH)
      .map((r: { id: number }) => r.id);
  } catch {
    // A query that the FTS5 parser rejects is a zero result, not a crash.
    return [];
  }
}

// ---------------------------------------------------------------------------
/** vec0 takes vectors as a raw float32 buffer, not as JSON and not as an array. */
const f32 = (values: number[]): Buffer => Buffer.from(new Float32Array(values).buffer);

/**
 * ## FUSION — why there are two strategies
 *
 * The first run measured one: RRF over three lists, `lex`, `tri` and `vec`, one
 * vote each. It lost to its own vector half on five of six models, by as much as
 * 15 points of recall@1. Fusing made retrieval **worse**.
 *
 * The reason is in the vote count. `lex` and `tri` are two views of the same
 * lexical signal, so a flat fusion hands the lexical side **two votes against the
 * vector side's one** — and on this data the lexical side scores 67.5% against
 * the vector side's 100%. The weaker, doubly-counted signal outvotes the stronger
 * one and drags good answers down the ranking.
 *
 * `staged` fixes the arithmetic rather than the design: fuse the two lexical
 * lists into one lexical ranking first, then fuse that against the vector
 * ranking. One vote each, which is what "combine lexical and vector" was always
 * supposed to mean.
 *
 * Both are measured every run. If staged still loses to the vector alone, that is
 * a real finding about ADR-0010 and not an arithmetic slip, and the report has to
 * say so.
 */

/** Reciprocal rank fusion over any number of ranked lists. */
function rrf(lists: number[][]): number[] {
  const score = new Map<number, number>();
  for (const list of lists) {
    for (const [i, id] of list.entries()) {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, DEPTH);
}

type Scores = { r1: number; r5: number; mrr: number; n: number };

function scoreRuns(runs: Array<{ ranked: number[]; expect: number }>): Scores {
  let r1 = 0;
  let r5 = 0;
  let mrr = 0;
  for (const { ranked, expect } of runs) {
    const rank = ranked.indexOf(expect);
    if (rank === 0) r1 += 1;
    if (rank >= 0 && rank < 5) r5 += 1;
    if (rank >= 0) mrr += 1 / (rank + 1);
  }
  const n = runs.length || 1;
  return { r1: r1 / n, r5: r5 / n, mrr: mrr / n, n: runs.length };
}

// Lexical scores do not depend on the model, so they are computed once and act as
// the floor every model has to improve on.
const lexicalRuns = dataset.queries.map((q) => ({
  expect: q.expect,
  query: q,
  ranked: rrf([lexicalSearch('lex', q.q), lexicalSearch('tri', q.q)]),
}));
const lexicalOnly = scoreRuns(lexicalRuns);
console.log(
  `  lexical alone   recall@1 ${pct(lexicalOnly.r1)}   recall@5 ${pct(lexicalOnly.r5)}   MRR ${lexicalOnly.mrr.toFixed(3)}`,
);

// ---------------------------------------------------------------------------
section(`models (${runnable.length} + control)`);

type ModelResult = {
  model: string;
  licence: string;
  dims: number;
  vector: Scores;
  /** RRF over three lists: lex, tri, vec. The obvious strategy, and the loser. */
  flat: Scores;
  /** RRF over two: (lex+tri fused first), vec. One lexical vote, one vector vote. */
  fused: Scores;
  byMechanism: Map<string, Scores>;
  byLang: Map<string, Scores>;
  embedMsP50: number;
  embedMsP95: number;
  indexMs: number;
  identical: number;
};

const modelResults: ModelResult[] = [];

// The noise floor runs first, so every model below is read against it rather than
// against zero.
const withControl: Candidate[] = [
  { model: RANDOM_CONTROL, licence: 'n/a', note: 'the noise floor' },
  ...runnable,
];

for (const candidate of withControl) {
  const isControl = candidate.model === RANDOM_CONTROL;
  console.log(`\n  ${candidate.model}`);
  const t0 = performance.now();

  let itemVectors: number[][];
  try {
    itemVectors = isControl
      ? dataset.items.map((i) => randomVector(i.text))
      : await embed(
          candidate.model,
          dataset.items.map((i) => i.text),
        );
  } catch (error) {
    // One model failing to load — out of VRAM, unsupported architecture — must
    // not end the comparison. It is a result about that model.
    console.log(`    FAILED: ${String(error).slice(0, 200)}`);
    continue;
  }
  const indexMs = performance.now() - t0;
  const dims = itemVectors[0]?.length ?? 0;
  console.log(`    dimensions    ${dims}`);
  console.log(`    index time    ${indexMs.toFixed(0)} ms for ${dataset.items.length} items`);

  // Sanity: the same text embedded twice must come back essentially identical.
  // If it does not, nothing measured below means anything.
  const twice = dataset.items[0]?.text ?? '';
  const [a, b] = isControl
    ? [randomVector(twice), randomVector(twice)]
    : await embed(candidate.model, [twice, twice]);
  const dot = a.reduce((s, x, i) => s + x * b[i], 0);
  const norm =
    Math.sqrt(a.reduce((s, x) => s + x * x, 0)) * Math.sqrt(b.reduce((s, x) => s + x * x, 0));
  const identical = dot / (norm || 1);
  console.log(`    self-similarity ${identical.toFixed(6)}`);

  db.exec('drop table if exists vec');
  db.exec(
    `create virtual table vec using vec0(id integer primary key, e float[${dims}] distance_metric=cosine)`,
  );
  const insertVec = db.prepare('insert into vec(id, e) values (?, ?)');
  for (const [i, item] of dataset.items.entries()) {
    // vec0 binds its primary key as an integer and its vectors as a float32
    // buffer. Passing a JS number or a JSON string fails at insert with a message
    // about primary keys that does not mention either — see spike 0002.
    insertVec.run(BigInt(item.id), f32(itemVectors[i] ?? []));
  }

  const knn = db.prepare('select id from vec where e match ? and k = ? order by distance');
  const latencies: number[] = [];
  const vectorRuns: Array<{ ranked: number[]; expect: number }> = [];
  const flatRuns: Array<{ ranked: number[]; expect: number }> = [];
  const stagedRuns: Array<{ ranked: number[]; expect: number }> = [];
  const perMechanism = new Map<Mechanism, Array<{ ranked: number[]; expect: number }>>();
  const perLang = new Map<string, Array<{ ranked: number[]; expect: number }>>();

  for (const [i, q] of dataset.queries.entries()) {
    const asked = `${candidate.queryPrefix ?? ''}${q.q}`;
    const qt = performance.now();
    const [qv] = isControl ? [randomVector(asked)] : await embed(candidate.model, [asked]);
    latencies.push(performance.now() - qt);

    const vecRanked = knn.all(f32(qv ?? []), DEPTH).map((r: { id: number }) => Number(r.id));
    const lexRanked = lexicalSearch('lex', q.q);
    const triRanked = lexicalSearch('tri', q.q);

    // Two fusion strategies, because the first run showed the obvious one losing
    // to its own vector half. See FUSION below.
    const flatRanked = rrf([lexRanked, triRanked, vecRanked]);
    const stagedRanked = rrf([rrf([lexRanked, triRanked]), vecRanked]);

    vectorRuns.push({ ranked: vecRanked, expect: q.expect });
    flatRuns.push({ ranked: flatRanked, expect: q.expect });
    stagedRuns.push({ ranked: stagedRanked, expect: q.expect });

    // Per-mechanism and per-language breakdowns follow the staged strategy,
    // which is the one the design would actually ship if it wins.
    const run = { ranked: stagedRanked, expect: q.expect };
    if (!perMechanism.has(q.mechanism)) perMechanism.set(q.mechanism, []);
    perMechanism.get(q.mechanism)?.push(run);
    if (!perLang.has(q.lang)) perLang.set(q.lang, []);
    perLang.get(q.lang)?.push(run);

    if (process.env['VERBOSE'] === '1') {
      const rank = stagedRanked.indexOf(q.expect);
      console.log(
        `      ${String(i + 1).padStart(2)} ${rank === 0 ? '✓' : rank < 0 ? '✗' : `#${rank + 1}`}  ${q.q}`,
      );
    }
  }

  latencies.sort((x, y) => x - y);
  const vector = scoreRuns(vectorRuns);
  const flat = scoreRuns(flatRuns);
  const fused = scoreRuns(stagedRuns);
  const line = (label: string, s: Scores) =>
    console.log(
      `    ${label.padEnd(13)} recall@1 ${pct(s.r1).padStart(6)}   recall@5 ${pct(s.r5).padStart(6)}   MRR ${s.mrr.toFixed(3)}`,
    );
  line('vector alone', vector);
  line('fused flat', flat);
  line('FUSED staged', fused);

  modelResults.push({
    model: candidate.model,
    licence: candidate.licence,
    dims,
    vector,
    flat,
    fused,
    byMechanism: new Map([...perMechanism].map(([k, v]) => [k, scoreRuns(v)])),
    byLang: new Map([...perLang].map(([k, v]) => [k, scoreRuns(v)])),
    embedMsP50: latencies[Math.floor(latencies.length * 0.5)] ?? Number.NaN,
    embedMsP95: latencies[Math.floor(latencies.length * 0.95)] ?? Number.NaN,
    indexMs,
    identical,
  });
}

check(
  '3 every runnable model produced vectors',
  modelResults.length === withControl.length,
  `${modelResults.length} of ${withControl.length} (including the control)`,
);

// ---------------------------------------------------------------------------
section('comparison');

const control = modelResults.find((r) => r.model === RANDOM_CONTROL);
modelResults.sort((a, b) => b.fused.mrr - a.fused.mrr);
console.log(
  '  model                       dims  vec@5  flat@5  STAGED@5   MRR    hu@5    en@5    gap   trunc@5   embed p50/p95',
);
for (const r of modelResults) {
  const hu = r.byLang.get('hu');
  const en = r.byLang.get('en');
  const gap = hu && en ? en.r5 - hu.r5 : Number.NaN;
  const trunc = r.byMechanism.get('truncation');
  console.log(
    `  ${r.model.padEnd(26)} ${String(r.dims).padStart(4)}  ${pct(r.vector.r5).padStart(6)}  ${pct(r.flat.r5).padStart(6)}  ${pct(r.fused.r5).padStart(7)}  ${r.fused.mrr.toFixed(3)}  ${(hu ? pct(hu.r5) : '—').padStart(6)}  ${(en ? pct(en.r5) : '—').padStart(6)}  ${(Number.isFinite(gap) ? pct(gap) : '—').padStart(6)}  ${(trunc ? pct(trunc.r5) : '—').padStart(7)}  ${`${r.embedMsP50.toFixed(0)}/${r.embedMsP95.toFixed(0)}`.padStart(9)} ms`,
  );
}
console.log(`  ${'lexical alone (no model)'.padEnd(26)}    —  ${pct(lexicalOnly.r5).padStart(6)}`);

// The winner is the best *real* model. The control is ranked alongside them on
// purpose — if it does not come last, that is the headline, not a footnote.
const best = modelResults.find((r) => r.model !== RANDOM_CONTROL);

// Scoring first does not make a model eligible to be the default. A licence with
// use restrictions is a property of the model, not a footnote to its benchmark,
// and every user inherits whatever this project defaults to.
const eligible = modelResults.find(
  (r) => r.model !== RANDOM_CONTROL && !r.licence.includes('NOT OSI'),
);
if (best && eligible && best.model !== eligible.model) {
  console.log(`\n  ⚠ ${best.model} scores highest but is not OSI-licensed (${best.licence}).`);
  console.log(
    `    Best model eligible to be the default: ${eligible.model} (${eligible.licence}).`,
  );
}
if (control && modelResults[0]?.model === RANDOM_CONTROL) {
  console.log('\n  ⚠ THE RANDOM CONTROL WON. No model contributed anything the lexical');
  console.log('    indexes were not already providing. Read every number below as noise.');
}
if (best) {
  console.log(`\n  by mechanism, ${best.model} (fused):`);
  for (const [mechanism, s] of best.byMechanism) {
    console.log(
      `    ${mechanism.padEnd(12)} recall@5 ${pct(s.r5).padStart(6)}   MRR ${s.mrr.toFixed(3)}   (${s.n} queries)`,
    );
  }
}

// ---------------------------------------------------------------------------
section('criteria');

check(
  '4 embeddings are deterministic',
  modelResults.every((r) => r.identical > 0.999),
  `worst self-similarity ${Math.min(...modelResults.map((r) => r.identical)).toFixed(6)}`,
);

// The criterion ADR-0010's two-index design lives or dies on. It is allowed to
// fail: if fusion never beats its best part, the design is carrying complexity
// for nothing and should be simplified.
//
// Beating the halves is necessary but nowhere near sufficient — random vectors
// managed it in a dry run. The real bar is the noise floor, and it is stated as a
// margin because on a set this size a single query is worth 2.5 points and a
// one-query lead is not a finding.
// Judged on MRR, not recall@5, and the reason is a design constraint rather than
// a preference for one statistic.
//
// Run 2 passed this criterion on recall@5 with a dead tie — 97.7% fused against
// 97.7% vector-alone — while the same run showed fusion costing 16 points of
// recall@1 and 0.11 of MRR. Recall@5 cannot see that, because it asks only
// whether the right memory is somewhere in the top five.
//
// Rank inside that window is not free. The retrieved-context block has a token
// budget (spike 0003 measured ~2,500 tokens of it), so a memory ranked fifth
// arrives alongside four irrelevant ones and competes with them for the agent's
// attention — or gets cut. MRR is what registers that; recall@5 is what let a
// regression through as a pass.
const MARGIN = 0.05;
const beatsHalves = best ? best.fused.mrr >= best.vector.mrr : false;
const beatsNoise = best && control ? best.fused.r5 >= control.fused.r5 + MARGIN : false;
check(
  '5 fusion earns its complexity (MRR) and beats the noise floor',
  beatsHalves && beatsNoise,
  best
    ? `staged MRR ${best.fused.mrr.toFixed(3)} vs vector-alone ${best.vector.mrr.toFixed(3)} (${best.fused.mrr >= best.vector.mrr ? '+' : ''}${(best.fused.mrr - best.vector.mrr).toFixed(3)}); recall@5 ${pct(best.fused.r5)} vs control ${control ? pct(control.fused.r5) : '—'}`
    : 'no model produced results',
);

// Whether the lexical indexes help or hurt turns out to depend on how good the
// vector index is, so the per-model deltas are printed rather than summarised.
// This is the table ADR-0010 has to be re-read against.
if (best) {
  console.log('        fusion delta against vector-alone, per model:');
  for (const r of modelResults) {
    if (r.model === RANDOM_CONTROL) continue;
    const d1 = r.fused.r1 - r.vector.r1;
    const dm = r.fused.mrr - r.vector.mrr;
    const sign = (x: number) => (x >= 0 ? '+' : '');
    console.log(
      `          ${r.model.padEnd(26)} recall@1 ${sign(d1)}${pct(d1).padStart(6)}   MRR ${sign(dm)}${dm.toFixed(3)}`,
    );
  }
}

// Reported whether or not criterion 5 passes, because "which fusion" is a
// separate question from "fusion at all", and the first run conflated them.
if (best) {
  const verdict =
    best.fused.r5 > best.flat.r5
      ? 'staged wins: collapsing the two lexical lists first is worth doing'
      : best.fused.r5 < best.flat.r5
        ? 'flat wins: the staged reweighting was not the problem'
        : 'tie at recall@5 — compare MRR and recall@1 before concluding';
  console.log(
    `        staged ${pct(best.fused.r5)} vs flat ${pct(best.flat.r5)} on ${best.model} — ${verdict}`,
  );
}

check(
  '6 fused recall@5 on the unstemmed language',
  (best?.byLang.get('hu')?.r5 ?? 0) >= 0.8,
  best ? `${best.model}: ${pct(best.byLang.get('hu')?.r5 ?? 0)} (threshold 80%)` : 'n/a',
);

// ADR-0012's actual fear, stated as a number for the first time.
const bestGap = best ? (best.byLang.get('en')?.r5 ?? 0) - (best.byLang.get('hu')?.r5 ?? 0) : 1;
check(
  '7 the winner does not degrade on the unstemmed language',
  bestGap <= 0.15,
  `english minus hungarian recall@5 = ${pct(bestGap)} (threshold 15 points)`,
);

// Named for the query path, because that is what this actually measures: one
// embed per question, on the critical path, added to whatever the turn already
// costs. The first version called it "per memory write" and pointed at the
// cheaper half — writes are batched and can run in the background, where the
// same milliseconds are free. The `index time` line above is the write path.
//
// p50 is printed beside p95 for a reason. A run where both are high says the
// model costs that much; a run where p50 is low and p95 is not says the tail is
// something else — scheduling, a model reload — and no faster hardware fixes it.
check(
  '8 query-path embedding latency is affordable',
  (best?.embedMsP95 ?? Number.POSITIVE_INFINITY) < 500,
  best
    ? `${best.model} p50 ${best.embedMsP50.toFixed(0)} ms, p95 ${best.embedMsP95.toFixed(0)} ms (threshold 500 ms on p95)`
    : 'n/a',
);

// A model whose context window is shorter than the item silently embeds the
// opening and loses the rest. Nothing errors, no vector is the wrong shape, and
// no other criterion here would notice.
const trunc = best?.byMechanism.get('truncation');
check(
  '9 long items are not silently truncated',
  (trunc?.r5 ?? 0) >= 0.8,
  best
    ? `${best.model}: ${pct(trunc?.r5 ?? 0)} on ${trunc?.n ?? 0} queries whose answer sits in the last sentence of a >512-token item`
    : 'n/a',
);

// ---------------------------------------------------------------------------
section('summary');
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}`);
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(
  failed.length === 0
    ? `  VERDICT: PASS — all ${results.length} criteria met`
    : `  VERDICT: FAIL — ${failed.length} of ${results.length} criteria not met`,
);
console.log(`  dataset: ${dataset.name}`);
if (!datasetPath) {
  console.log('  NOTE: this is the public set, whose queries were written alongside its items.');
  console.log('        The default model must not be chosen on this number alone. See README.');
}
db.close();
process.exit(failed.length === 0 ? 0 : 1);

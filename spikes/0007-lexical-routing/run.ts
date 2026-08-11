/**
 * Spike 0007 — is the lexical index a specialist or a voter?
 *
 * ⚠️ **THIS SPIKE FAILED AND ITS NUMBERS ARE NOT EVIDENCE.** It missed its own
 * pre-registered criterion 2 (vector recall@1 measured 75.0% against a "below
 * 60%" bar) and an adversarial review then found four defects that invalidate the
 * rest. Read `docs/spikes/0007-lexical-routing.md` before running it, and do not
 * quote its output.
 *
 * The four, in short: the distractor ranges ascend from a floor so crowding
 * arrives *after* the drop it was supposed to cause; every queried identifier is
 * unique by construction, so "lexical is scale-independent" is a property of the
 * generator; the two winning arms are the only ones that skip the trigram index,
 * confounding the gate with dropping it; and one query in twelve has 120 valid
 * answers. It is kept because the defects are easier to see in running code.
 *
 * Throwaway. See README.md for the pass criteria, written down before this ran.
 * **Consumes no AI usage.**
 *
 * [Spike 0006](../../docs/spikes/0006-multilingual-retrieval.md) found
 * [ADR-0010](../../docs/adr/0010-sqlite-storage.md)'s unconditional fusion making
 * the best model measurably worse. It could not say what to do instead, because
 * its test set contained almost none of the queries a lexical index exists for.
 *
 * This one builds those queries first — near-duplicate items differing only in an
 * identifier — and then compares five ways of combining the indexes on a set that
 * contains both kinds of question.
 *
 * Criterion 2 is written so this spike can conclude the lexical indexes should be
 * **deleted**. If pure vector search handles exact identifiers, they have no
 * specialist role either.
 */

import { readFileSync } from 'node:fs';
import { arch, cpus, release, totalmem, type } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { DATASET, distractors, type Half, type Query, validate } from './dataset.ts';

const OLLAMA = process.env['OLLAMA_URL'] ?? 'http://127.0.0.1:11434';
/**
 * Deliberately not called `MODEL`: `spikes/model.ts` exports that name for the
 * Claude tier a spike runs against, and this is the embedding model. Two meanings
 * on one identifier across a shared directory is how a reader ends up confidently
 * wrong, and `check-spikes.mjs` flags it.
 */
const EMBED_MODEL = process.env['EMBED_MODEL'] ?? 'bge-m3';
const VERBOSE = process.env['VERBOSE'] === '1';

/** RRF constant; 60 is the value from the original paper. */
const RRF_K = 60;
/** Retrieval depth. Recall reported at 1 and 5, MRR computed over this. */
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
console.log(`  memory          ${(totalmem() / 1e9).toFixed(1)} GB`);
console.log(`  Node.js         ${process.version}`);
console.log(
  `  better-sqlite3  ${JSON.parse(readFileSync('./package.json', 'utf8')).dependencies['better-sqlite3']}`,
);
console.log(`  ollama at       ${OLLAMA}`);
console.log(`  model           ${EMBED_MODEL}`);

// ---------------------------------------------------------------------------
section('dataset');
const problems = validate(DATASET);
for (const p of problems) console.log(`  PROBLEM  ${p}`);
const exactQueries = DATASET.queries.filter((q) => q.half === 'exact');
const semanticQueries = DATASET.queries.filter((q) => q.half === 'semantic');
console.log(`  items           ${DATASET.items.length}`);
console.log(`  exact queries   ${exactQueries.length}`);
console.log(`  semantic        ${semanticQueries.length}`);
check('0 dataset is coherent', problems.length === 0, `${problems.length} problem(s)`);
if (problems.length > 0) process.exit(1);

// ---------------------------------------------------------------------------
section('ollama');

async function embed(input: string[]): Promise<number[][]> {
  const response = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  const body = (await response.json()) as { embeddings: number[][] };
  return body.embeddings;
}

let ok = false;
try {
  const tags = (await (await fetch(`${OLLAMA}/api/tags`)).json()) as {
    models: Array<{ name: string }>;
  };
  ok = tags.models.some((m) => m.name === EMBED_MODEL || m.name === `${EMBED_MODEL}:latest`);
  console.log(`  reachable       yes, ${tags.models.length} model(s)`);
} catch (error) {
  console.log(`  reachable       NO — ${String(error)}`);
}
check('1 ollama reachable and model present', ok, `${EMBED_MODEL} at ${OLLAMA}`);
if (!ok) process.exit(1);

// ---------------------------------------------------------------------------
section('indexes');

const db = new Database(':memory:');
sqliteVec.load(db);
console.log(`  sqlite          ${db.prepare('select sqlite_version() v').get().v}`);
console.log(`  sqlite-vec      ${db.prepare('select vec_version() v').get().v}`);

/**
 * Corpus sizes measured. The real items are always present; the rest are
 * generated distractors in the same shape.
 *
 * Everything is embedded once, at the largest scale, and each smaller scale uses
 * a prefix of it — so the whole curve costs one embedding pass instead of one per
 * point. On the target machine that pass is the only slow part of this spike.
 */
const SCALES = (process.env['SCALES'] ?? '28,100,300,1000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= DATASET.items.length)
  .sort((a, b) => a - b);

const maxScale = SCALES[SCALES.length - 1] ?? DATASET.items.length;
const padding = distractors(Math.max(0, maxScale - DATASET.items.length));
const allItems = [...DATASET.items, ...padding];
console.log(`  scales          ${SCALES.join(', ')}`);
console.log(`  embedding       ${allItems.length} items — the slow step, once`);

const t0 = performance.now();
const itemVectors: number[][] = [];
const BATCH = 32;
for (let i = 0; i < allItems.length; i += BATCH) {
  const batch = allItems.slice(i, i + BATCH);
  itemVectors.push(...(await embed(batch.map((it) => it.text))));
  process.stdout.write(`\r  progress        ${itemVectors.length}/${allItems.length}`);
}
console.log(
  `\r  embedded        ${itemVectors.length} items in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
);

const dims = itemVectors[0]?.length ?? 0;
const f32 = (v: number[]): Buffer => Buffer.from(new Float32Array(v).buffer);
console.log(`  dimensions      ${dims}`);

/** Rebuilds all three indexes over the first `scale` items. */
function buildIndexes(scale: number): void {
  db.exec('drop table if exists lex');
  db.exec('drop table if exists tri');
  db.exec('drop table if exists vec');
  db.exec('create virtual table lex using fts5(body, tokenize = "unicode61 remove_diacritics 2")');
  db.exec('create virtual table tri using fts5(body, tokenize = "trigram")');
  db.exec(
    `create virtual table vec using vec0(id integer primary key, e float[${dims}] distance_metric=cosine)`,
  );
  const insLex = db.prepare('insert into lex(rowid, body) values (?, ?)');
  const insTri = db.prepare('insert into tri(rowid, body) values (?, ?)');
  const insVec = db.prepare('insert into vec(id, e) values (?, ?)');
  const tx = db.transaction(() => {
    for (let i = 0; i < scale; i++) {
      const item = allItems[i];
      if (!item) continue;
      insLex.run(item.id, item.text);
      insTri.run(item.id, item.text);
      insVec.run(BigInt(item.id), f32(itemVectors[i] ?? []));
    }
  });
  tx();
}

/** Tokens shorter than three characters cannot match the trigram tokenizer. */
function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}@._/-]+/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}
function ftsQuery(q: string): string {
  return tokens(q)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/** Ranked ids plus their bm25 scores, which router-confidence needs. */
function lexicalSearch(table: 'lex' | 'tri', q: string): Array<{ id: number; score: number }> {
  const match = ftsQuery(q);
  if (!match) return [];
  try {
    return db
      .prepare(
        `select rowid as id, bm25(${table}) as score from ${table} where ${table} match ? order by score limit ?`,
      )
      .all(match, DEPTH) as Array<{ id: number; score: number }>;
  } catch {
    return [];
  }
}

function rrf(lists: number[][], weights?: number[]): number[] {
  const score = new Map<number, number>();
  for (const [li, list] of lists.entries()) {
    const w = weights?.[li] ?? 1;
    for (const [i, id] of list.entries()) {
      score.set(id, (score.get(id) ?? 0) + w / (RRF_K + i + 1));
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id)
    .slice(0, DEPTH);
}

// ---------------------------------------------------------------------------
// The strategies. Each takes the three ranked lists for one query and returns a
// single ranking, so the only thing that differs between them is the rule.
// ---------------------------------------------------------------------------

/**
 * Does the query look like it names an identifier? Digits, an email, or a code
 * with mixed digits and separators. A regex on the query text — no index lookup,
 * no model, and therefore no excuse for being slow.
 */
const IDENTIFIER = /[\w.+-]+@[\w-]+\.\w+|\d[\d\s/.-]{3,}|\b[A-Za-zÁÉÍÓÖŐÚÜŰ]{2,}-\d[\w-]*\b/u;
const looksExact = (q: string): boolean => IDENTIFIER.test(q);

/**
 * bm25 in SQLite returns a negative number, more negative meaning a better match.
 * A top hit far ahead of the runner-up means the query contained something
 * selective — which is exactly the condition under which a lexical index should
 * be believed, and it is measured rather than guessed.
 *
 * The margin is expressed as a ratio so it does not depend on corpus size.
 */
function lexicalIsConfident(hits: Array<{ id: number; score: number }>, margin: number): boolean {
  const top = hits[0];
  const next = hits[1];
  if (!top) return false;
  if (!next) return true;
  return Math.abs(top.score) >= Math.abs(next.score) * margin;
}

/**
 * Margins swept, rather than one chosen.
 *
 * Run 4 recommended the confidence router on the strength of a single margin —
 * 1.5, which was invented, never tuned, and would have become load-bearing for an
 * ADR amendment. This project has twice caught a result resting on a number
 * nobody measured, and shipping a third would be a pattern rather than an
 * accident.
 *
 * A sweep answers the question that matters more than the winner's score: is the
 * router a real mechanism, or one lucky constant? A flat curve across margins
 * means the signal is robust and the exact value does not matter. A spike at one
 * value means the opposite, and the recommendation should not be made.
 */
const MARGINS = [1.05, 1.2, 1.5, 2, 3, 5];
/** The margin whose numbers are quoted when a single figure is needed. */
const REFERENCE_MARGIN = 1.5;

type Lists = {
  lex: Array<{ id: number; score: number }>;
  tri: Array<{ id: number; score: number }>;
  vec: number[];
};

const ids = (xs: Array<{ id: number }>): number[] => xs.map((x) => x.id);

/**
 * The lexical weights swept. The README promised a sweep and the first draft of
 * this file hard-coded a single 0.3 — the kind of drift between stated criteria
 * and implementation that made spike 0006's first run worthless.
 *
 * A sweep answers a question one weight cannot: whether fusion fails *because it
 * is fusion*, or only because 0006 weighted the two sides 1:1. If every weight
 * loses to pure vector, the first is true and no amount of tuning rescues it.
 */
const WEIGHTS = [0.1, 0.2, 0.3, 0.5, 0.7, 0.9];

const STRATEGIES: Record<string, (l: Lists, q: string) => number[]> = {
  vector: (l) => l.vec,
  'rrf-staged': (l) => rrf([rrf([ids(l.lex), ids(l.tri)]), l.vec]),
  'router-shape': (l, q) => (looksExact(q) ? rrf([rrf([ids(l.lex), ids(l.tri)]), l.vec]) : l.vec),
  'router-confidence': (l) =>
    lexicalIsConfident(l.lex, REFERENCE_MARGIN) ? rrf([ids(l.lex), l.vec], [1, 1]) : l.vec,
  // The router that consults the index *and* respects the query shape: use
  // lexical only where it is both plausible and confident.
  'router-both': (l, q) =>
    looksExact(q) && lexicalIsConfident(l.lex, REFERENCE_MARGIN)
      ? rrf([ids(l.lex), l.vec], [1, 1])
      : l.vec,
};
for (const w of WEIGHTS) {
  STRATEGIES[`rrf-weighted-${w}`] = (l) => rrf([rrf([ids(l.lex), ids(l.tri)]), l.vec], [w, 1]);
}
for (const m of MARGINS) {
  STRATEGIES[`router-conf-m${m}`] = (l) =>
    lexicalIsConfident(l.lex, m) ? rrf([ids(l.lex), l.vec], [1, 1]) : l.vec;
}

// ---------------------------------------------------------------------------
section('running');

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

/** Stands in when a bucket is absent, so a missing slice reads as zero, not NaN. */
const EMPTY: Scores = { r1: 0, r5: 0, mrr: 0, n: 0 };

const push = (
  m: Map<Half | 'all', Array<{ ranked: number[]; expect: number }>>,
  q: Query,
  ranked: number[],
) => {
  for (const key of [q.half, 'all'] as const) {
    if (!m.has(key)) m.set(key, []);
    m.get(key)?.push({ ranked, expect: q.expect });
  }
};

// Queries are embedded once — they do not change with the corpus.
const queryVectors = await embed(DATASET.queries.map((q) => q.q));

/** Everything measured at one corpus size. */
type ScaleResult = {
  scale: number;
  perStrategy: Map<string, Map<Half | 'all', Scores>>;
  lexicalOnly: Map<Half | 'all', Scores>;
  routingMsPerQuery: number;
};

const scaleResults: ScaleResult[] = [];

for (const scale of SCALES) {
  buildIndexes(scale);
  const knn = db.prepare('select id from vec where e match ? and k = ? order by distance');

  const perStrategy = new Map<
    string,
    Map<Half | 'all', Array<{ ranked: number[]; expect: number }>>
  >();
  const lexicalOnly = new Map<Half | 'all', Array<{ ranked: number[]; expect: number }>>();
  let routingMs = 0;

  for (const [qi, q] of DATASET.queries.entries()) {
    const lists: Lists = {
      lex: lexicalSearch('lex', q.q),
      tri: lexicalSearch('tri', q.q),
      vec: knn.all(f32(queryVectors[qi] ?? []), DEPTH).map((r: { id: number }) => Number(r.id)),
    };

    push(lexicalOnly, q, rrf([ids(lists.lex), ids(lists.tri)]));

    for (const [name, strategy] of Object.entries(STRATEGIES)) {
      const t0 = performance.now();
      const ranked = strategy(lists, q.q);
      routingMs += performance.now() - t0;
      if (!perStrategy.has(name)) perStrategy.set(name, new Map());
      const m = perStrategy.get(name);
      if (m) push(m, q, ranked);
      if (VERBOSE && name === 'router-confidence' && scale === maxScale) {
        const rank = ranked.indexOf(q.expect);
        console.log(
          `    ${q.half === 'exact' ? 'E' : 'S'} ${rank === 0 ? '✓' : rank < 0 ? '✗' : `#${rank + 1}`}  ${q.q}`,
        );
      }
    }
  }

  const summarise = (m: Map<Half | 'all', Array<{ ranked: number[]; expect: number }>>) =>
    new Map([...m].map(([k, v]) => [k, scoreRuns(v)]));
  scaleResults.push({
    scale,
    perStrategy: new Map([...perStrategy].map(([k, v]) => [k, summarise(v)])),
    lexicalOnly: summarise(lexicalOnly),
    routingMsPerQuery: routingMs / (DATASET.queries.length * Object.keys(STRATEGIES).length),
  });
  console.log(`  scale ${String(scale).padStart(5)}     measured`);
}

const largest = scaleResults[scaleResults.length - 1];
const routingPerQuery = Math.max(...scaleResults.map((s) => s.routingMsPerQuery));

// ---------------------------------------------------------------------------
section('exact-match recall@1 as the corpus grows');
console.log('  This is the question run 1 could not ask, because it measured one size.');
console.log('');
const CURVE = ['vector', 'rrf-staged', 'router-shape', 'router-confidence'];
console.log(`  strategy             ${SCALES.map((s) => String(s).padStart(7)).join('')}`);
for (const name of CURVE) {
  const cells = scaleResults.map((sr) => {
    const v = sr.perStrategy.get(name)?.get('exact')?.r1;
    return (v === undefined ? '—' : pct(v)).padStart(7);
  });
  console.log(`  ${name.padEnd(20)} ${cells.join('')}`);
}
const lexCells = scaleResults.map((sr) => pct(sr.lexicalOnly.get('exact')?.r1 ?? 0).padStart(7));
console.log(`  ${'lexical alone'.padEnd(20)} ${lexCells.join('')}`);

// ---------------------------------------------------------------------------
// Everything below judges the LARGEST corpus. Run 1's mistake was reporting one
// size as though it were the answer; reporting the smallest would repeat it in
// the other direction. The curve above is what the reader should weigh, and the
// criteria are evaluated where the system is most like the thing being designed.
section(`is exact matching a vector weakness at ${maxScale} items?`);

const at = largest;
const vectorExact = at?.perStrategy.get('vector')?.get('exact') ?? EMPTY;
const vectorSemantic = at?.perStrategy.get('vector')?.get('semantic') ?? EMPTY;
const lexExact = at?.lexicalOnly.get('exact') ?? EMPTY;
const lexSemantic = at?.lexicalOnly.get('semantic') ?? EMPTY;

console.log(
  `  vector   exact  recall@1 ${pct(vectorExact.r1)}   MRR ${vectorExact.mrr.toFixed(3)}`,
);
console.log(`  lexical  exact  recall@1 ${pct(lexExact.r1)}   MRR ${lexExact.mrr.toFixed(3)}`);
console.log(
  `  vector   semant recall@1 ${pct(vectorSemantic.r1)}   MRR ${vectorSemantic.mrr.toFixed(3)}`,
);
console.log(
  `  lexical  semant recall@1 ${pct(lexSemantic.r1)}   MRR ${lexSemantic.mrr.toFixed(3)}`,
);

check(
  '2 pure vector search fails on exact-match queries',
  vectorExact.r1 < 0.6,
  `recall@1 ${pct(vectorExact.r1)} on ${vectorExact.n} queries (threshold: below 60%)`,
);
check(
  '3 lexical search succeeds on them',
  lexExact.r1 >= 0.9,
  `recall@1 ${pct(lexExact.r1)} (threshold 90%)`,
);
check(
  '4 vector still wins the semantic half',
  vectorSemantic.mrr > lexSemantic.mrr,
  `vector MRR ${vectorSemantic.mrr.toFixed(3)} vs lexical ${lexSemantic.mrr.toFixed(3)}`,
);

// ---------------------------------------------------------------------------
section(`strategies at ${maxScale} items`);

type Row = { name: string; all: Scores; exact: Scores; semantic: Scores };
const rows: Row[] = [...(at?.perStrategy ?? new Map())].map(([name, m]) => ({
  name,
  all: m.get('all') ?? EMPTY,
  exact: m.get('exact') ?? EMPTY,
  semantic: m.get('semantic') ?? EMPTY,
}));
rows.sort((a, b) => b.all.mrr - a.all.mrr);

console.log('  strategy              all MRR   all@1   exact@1  exact MRR   sem@1   sem MRR');
for (const r of rows) {
  console.log(
    `  ${r.name.padEnd(20)} ${r.all.mrr.toFixed(3).padStart(7)}  ${pct(r.all.r1).padStart(6)}  ${pct(r.exact.r1).padStart(7)}  ${r.exact.mrr.toFixed(3).padStart(9)}  ${pct(r.semantic.r1).padStart(6)}  ${r.semantic.mrr.toFixed(3).padStart(7)}`,
  );
}

const baseline = rows.find((r) => r.name === 'vector');
const best = rows.find((r) => r.name !== 'vector');

// ---------------------------------------------------------------------------
section('criteria');

check(
  '5 a strategy beats pure vector on the combined set',
  Boolean(best && baseline && best.all.mrr > baseline.all.mrr),
  best && baseline
    ? `best non-vector is ${best.name} at MRR ${best.all.mrr.toFixed(3)} vs vector ${baseline.all.mrr.toFixed(3)}`
    : 'n/a',
);

// A strategy that fixes exact matching by breaking semantic retrieval has not
// helped. 0.02 is roughly one query's worth of MRR on this set.
const SEM_TOLERANCE = 0.02;
check(
  '6 …without regressing the semantic half',
  Boolean(best && baseline && best.semantic.mrr >= baseline.semantic.mrr - SEM_TOLERANCE),
  best && baseline
    ? `${best.name} semantic MRR ${best.semantic.mrr.toFixed(3)} vs vector ${baseline.semantic.mrr.toFixed(3)} (tolerance ${SEM_TOLERANCE})`
    : 'n/a',
);

check(
  '7 routing costs nothing meaningful',
  routingPerQuery < 5,
  `${routingPerQuery.toFixed(3)} ms per query (threshold 5 ms, excludes the embed)`,
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
db.close();
process.exit(failed.length === 0 ? 0 : 1);

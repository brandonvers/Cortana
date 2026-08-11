/**
 * Spike 0007 — is the lexical index a specialist or a voter?
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
import { DATASET, type Half, type Query, validate } from './dataset.ts';

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

db.exec('create virtual table lex using fts5(body, tokenize = "unicode61 remove_diacritics 2")');
db.exec('create virtual table tri using fts5(body, tokenize = "trigram")');
const insLex = db.prepare('insert into lex(rowid, body) values (?, ?)');
const insTri = db.prepare('insert into tri(rowid, body) values (?, ?)');
for (const item of DATASET.items) {
  insLex.run(item.id, item.text);
  insTri.run(item.id, item.text);
}

const itemVectors = await embed(DATASET.items.map((i) => i.text));
const dims = itemVectors[0]?.length ?? 0;
const f32 = (v: number[]): Buffer => Buffer.from(new Float32Array(v).buffer);
db.exec(
  `create virtual table vec using vec0(id integer primary key, e float[${dims}] distance_metric=cosine)`,
);
const insVec = db.prepare('insert into vec(id, e) values (?, ?)');
for (const [i, item] of DATASET.items.entries())
  insVec.run(BigInt(item.id), f32(itemVectors[i] ?? []));
console.log(`  indexed         ${DATASET.items.length} items, ${dims} dimensions`);

const knn = db.prepare('select id from vec where e match ? and k = ? order by distance');

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
const CONFIDENCE_MARGIN = 1.5;
function lexicalIsConfident(hits: Array<{ id: number; score: number }>): boolean {
  const top = hits[0];
  const next = hits[1];
  if (!top) return false;
  if (!next) return true;
  return Math.abs(top.score) >= Math.abs(next.score) * CONFIDENCE_MARGIN;
}

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
    lexicalIsConfident(l.lex) ? rrf([ids(l.lex), l.vec], [1, 1]) : l.vec,
  // The router that consults the index *and* respects the query shape: use
  // lexical only where it is both plausible and confident.
  'router-both': (l, q) =>
    looksExact(q) && lexicalIsConfident(l.lex) ? rrf([ids(l.lex), l.vec], [1, 1]) : l.vec,
};
for (const w of WEIGHTS) {
  STRATEGIES[`rrf-weighted-${w}`] = (l) => rrf([rrf([ids(l.lex), ids(l.tri)]), l.vec], [w, 1]);
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

const perStrategy = new Map<
  string,
  Map<Half | 'all', Array<{ ranked: number[]; expect: number }>>
>();
const lexicalOnly = new Map<Half | 'all', Array<{ ranked: number[]; expect: number }>>();
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

let routingMs = 0;
for (const q of DATASET.queries) {
  const [qv] = await embed([q.q]);
  const lists: Lists = {
    lex: lexicalSearch('lex', q.q),
    tri: lexicalSearch('tri', q.q),
    vec: knn.all(f32(qv ?? []), DEPTH).map((r: { id: number }) => Number(r.id)),
  };

  push(lexicalOnly, q, rrf([ids(lists.lex), ids(lists.tri)]));

  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    const t0 = performance.now();
    const ranked = strategy(lists, q.q);
    routingMs += performance.now() - t0;
    if (!perStrategy.has(name)) perStrategy.set(name, new Map());
    const m = perStrategy.get(name);
    if (m) push(m, q, ranked);
    if (VERBOSE && name === 'router-confidence') {
      const rank = ranked.indexOf(q.expect);
      console.log(
        `    ${q.half === 'exact' ? 'E' : 'S'} ${rank === 0 ? '✓' : rank < 0 ? '✗' : `#${rank + 1}`}  ${q.q}`,
      );
    }
  }
}
const routingPerQuery = routingMs / (DATASET.queries.length * Object.keys(STRATEGIES).length);
console.log(`  routing cost    ${routingPerQuery.toFixed(3)} ms per query per strategy`);

// ---------------------------------------------------------------------------
section('is exact matching actually a vector weakness?');

const vectorRuns = perStrategy.get('vector');
const vectorExact = scoreRuns(vectorRuns?.get('exact') ?? []);
const vectorSemantic = scoreRuns(vectorRuns?.get('semantic') ?? []);
const lexExact = scoreRuns(lexicalOnly.get('exact') ?? []);
const lexSemantic = scoreRuns(lexicalOnly.get('semantic') ?? []);

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
section('strategies');

type Row = { name: string; all: Scores; exact: Scores; semantic: Scores };
const rows: Row[] = [...perStrategy.entries()].map(([name, m]) => ({
  name,
  all: scoreRuns(m.get('all') ?? []),
  exact: scoreRuns(m.get('exact') ?? []),
  semantic: scoreRuns(m.get('semantic') ?? []),
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

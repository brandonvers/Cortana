/**
 * Spike 0002 — sqlite-vec, FTS5, and inflected languages.
 *
 * Throwaway. Consumes no AI usage. See README.md for the pass criteria, which
 * were written down before this was run.
 */

import { cpus, totalmem, type, release, arch } from 'node:os';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Reporting helpers. A spike that a human has to interpret gets interpreted
// wrongly, so every criterion prints an explicit PASS or FAIL.
// ---------------------------------------------------------------------------

const results: Array<{ id: string; ok: boolean; detail: string }> = [];

function check(id: string, ok: boolean, detail: string): void {
  results.push({ id, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${detail}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);
}

const version = (pkg: string): string => {
  try {
    const p = new URL(`./node_modules/${pkg}/package.json`, import.meta.url);
    return JSON.parse(readFileSync(p, 'utf8')).version;
  } catch {
    return 'unknown';
  }
};

// ---------------------------------------------------------------------------
// Environment. Recorded so the result can be re-checked after an upgrade, and
// so a difference between machines has something to point at.
// ---------------------------------------------------------------------------

section('environment');
let distro = '';
try {
  const os = readFileSync('/etc/os-release', 'utf8');
  distro = /PRETTY_NAME="?([^"\n]+)"?/.exec(os)?.[1] ?? '';
} catch {
  distro = `${type()} ${release()}`;
}
const cpu = cpus();
console.log(`  os              ${distro}`);
console.log(`  arch            ${arch()}`);
console.log(`  cpu             ${cpu[0]?.model?.trim() ?? '?'} × ${cpu.length}`);
console.log(`  memory          ${(totalmem() / 1024 ** 3).toFixed(1)} GB`);
console.log(`  node            ${process.version}`);
console.log(`  better-sqlite3  ${version('better-sqlite3')}`);
console.log(`  sqlite-vec      ${version('sqlite-vec')}`);
console.log(`  drizzle-orm     ${version('drizzle-orm')}`);

// Criterion 7: reaching this line at all proves it, since this file is .ts and
// was executed with `node run.ts`.
check('7 type-stripping', true, 'node executed this .ts file with no build step');

// ---------------------------------------------------------------------------
// Criterion 1 — the extension loads with no custom SQLite installation
// ---------------------------------------------------------------------------

section('sqlite-vec extension');
const db = new Database(':memory:');
db.pragma('journal_mode = WAL');

let sqliteVersion = '';
let vecVersion = '';
try {
  sqliteVec.load(db);
  const row = db
    .prepare('select sqlite_version() as s, vec_version() as v')
    .get() as { s: string; v: string };
  sqliteVersion = row.s;
  vecVersion = row.v;
  check('1 extension loads', true, `sqlite ${sqliteVersion}, sqlite-vec ${vecVersion}`);
} catch (error) {
  check('1 extension loads', false, String(error));
  console.error('\nThe extension did not load. Nothing after this is meaningful.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Criterion 2 — vec0 accepts vectors and answers KNN
//
// Two binding rules found on macOS and re-checked here: the rowid must be bound
// as a BigInt, and the vector as a Buffer. A plain number fails with a message
// that says integers are required, which is misleading because the value was one.
// ---------------------------------------------------------------------------

section('vec0 KNN');
const f32 = (values: number[]): Buffer => Buffer.from(new Float32Array(values).buffer);

db.exec('create virtual table v using vec0(id integer primary key, e float[4])');
const insert4 = db.prepare('insert into v(id, e) values (?, ?)');
insert4.run(BigInt(1), f32([1, 0, 0, 0]));
insert4.run(BigInt(2), f32([0, 1, 0, 0]));
insert4.run(BigInt(3), f32([0.9, 0.1, 0, 0]));

const knn = db
  .prepare('select id, distance from v where e match ? and k = 2 order by distance')
  .all(f32([1, 0, 0, 0])) as Array<{ id: number; distance: number }>;

check(
  '2 vec0 KNN',
  knn.length === 2 && knn[0]?.id === 1 && knn[1]?.id === 3,
  `nearest=${knn.map((r) => r.id).join(',')} (expected 1,3)`,
);

// ---------------------------------------------------------------------------
// Criteria 3-5 — the language behaviour
//
// Hungarian is agglutinative and FTS5 has no stemmer for it. "házban" means "in
// the house"; the stem is "ház". Criterion 4 exists to demonstrate the failure
// rather than assume it, because the failure is silent: the query succeeds and
// returns nothing, and that empty result then poisons the rank fusion.
// ---------------------------------------------------------------------------

section('FTS5 on an inflected language');
const TEXT = 'A házban ülő őrült tűzoltó';

db.exec(`create virtual table f using fts5(body, tokenize = "unicode61 remove_diacritics 2")`);
db.prepare('insert into f(body) values (?)').run(TEXT);

const ftsHits = (q: string): number =>
  (db.prepare('select body from f where f match ?').all(q) as unknown[]).length;

check('3 diacritic folding', ftsHits('hazban') === 1, `"hazban" (no accents) → ${ftsHits('hazban')} hit(s)`);
check(
  '4 no stemmer (expected)',
  ftsHits('haz') === 0,
  `"haz" (stem) → ${ftsHits('haz')} hit(s); 0 confirms the silent failure`,
);

db.exec(`create virtual table t using fts5(body, tokenize = "trigram")`);
db.prepare('insert into t(body) values (?)').run(TEXT);
const triHits = (db.prepare('select body from t where t match ?').all('ház') as unknown[]).length;
check('5 trigram rescues it', triHits === 1, `"ház" against trigram → ${triHits} hit(s)`);

// ---------------------------------------------------------------------------
// Criterion 6 — the query layer on the same connection
// ---------------------------------------------------------------------------

section('drizzle on the same connection');
const d = drizzle(db);
const two = d.get<{ n: number }>(sql`select 1 + 1 as n`);
check('6 drizzle', two?.n === 2, `select 1+1 → ${two?.n}`);

// ---------------------------------------------------------------------------
// Criterion 8 — does brute-force KNN scale to a realistic corpus?
//
// sqlite-vec has no approximate index, so every query scans every vector. At
// personal-memory scale that is exact and should be fast, but "should" is what
// this spike exists to replace. 384 dimensions matches a small multilingual
// embedding model.
// ---------------------------------------------------------------------------

section('brute-force KNN at scale');
const DIMS = 384;
const ROWS = 10_000;

db.exec(`create virtual table big using vec0(id integer primary key, e float[${DIMS}])`);

// Deterministic pseudo-random vectors — no Math.random, so a re-run compares.
let seed = 12345;
const nextUnit = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff - 0.5;
};
const randomVector = (): Buffer =>
  f32(Array.from({ length: DIMS }, () => nextUnit()));

const insertBig = db.prepare('insert into big(id, e) values (?, ?)');
const insertMany = db.transaction((n: number) => {
  for (let i = 1; i <= n; i++) insertBig.run(BigInt(i), randomVector());
});

const writeStart = performance.now();
insertMany(ROWS);
const writeMs = performance.now() - writeStart;
console.log(`  inserted ${ROWS.toLocaleString()} × ${DIMS}d in ${writeMs.toFixed(0)} ms`);

const query = db.prepare('select id, distance from big where e match ? and k = 10 order by distance');
const timings: number[] = [];
for (let i = 0; i < 50; i++) {
  const probe = randomVector();
  const t0 = performance.now();
  query.all(probe);
  timings.push(performance.now() - t0);
}
timings.sort((a, b) => a - b);
const p50 = timings[Math.floor(timings.length * 0.5)] ?? 0;
const p95 = timings[Math.floor(timings.length * 0.95)] ?? 0;

console.log(`  KNN k=10 over ${ROWS.toLocaleString()} vectors: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms`);
check('8 brute-force is fast enough', p95 < 50, `p95 ${p95.toFixed(1)} ms (threshold 50 ms)`);

// ---------------------------------------------------------------------------

section('summary');
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.id}`);
console.log('');
if (failed.length === 0) {
  console.log(`  VERDICT: PASS — all ${results.length} criteria met`);
} else {
  console.log(`  VERDICT: FAIL — ${failed.length} of ${results.length} criteria not met`);
}
db.close();
process.exit(failed.length === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * Typechecks the spikes, which the main `tsc` run deliberately does not.
 *
 * Spikes are excluded from the root tsconfig because each pins its own
 * dependencies outside the workspace, so the compiler cannot resolve their
 * imports. That exclusion has now hidden two defects: a duplicate declaration
 * that stopped a harness from starting, and a missing import that would have
 * thrown at runtime with the symbol used a hundred lines below.
 *
 * Linting caught the first once spikes were linted. It cannot catch the second,
 * because an undeclared identifier is a type error rather than a style one.
 *
 * So this does the cheapest thing that closes the gap and needs no dependency
 * resolution: it strips each spike with Node's own type stripper — the exact
 * mechanism that will run the file — and then checks that every identifier
 * imported from a relative module is actually exported by it.
 *
 * That claim about the mechanism was false until 2026-08-31. The check used to
 * shell out to `node --experimental-strip-types --check`, which does not strip
 * types the way running the file does: it reports a syntax error for valid
 * TypeScript depending on what appears before the first `export`.
 *
 *   const x: number = 1;                    --check FAILS,  node runs it
 *   const x: number = 1; export const y=x;  --check FAILS,  node runs it
 *   export type T = string; const x: T='a'; --check passes, node runs it
 *
 * Every spike passed anyway because they all happen to open with an import or an
 * export. That was luck: the first file to begin with an annotated declaration
 * would have been reported as a syntax error that isn't one. `module`'s
 * `stripTypeScriptTypes` is the actual stripper, and it answers both questions
 * this check asks in one call — it rejects real syntax errors and rejects
 * anything not erasable, which is what `erasableSyntaxOnly` demands of the
 * packages and what a spike must satisfy to run at all.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';

// The stripper is still flagged experimental, and its one-time warning would
// print above a passing run and read like a problem. Only that warning is
// dropped — `--no-warnings` would hide every other one too, which is how a real
// deprecation notice goes unnoticed for a year.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /stripTypeScriptTypes/.test(warning.message))
    return;
  console.warn(`${warning.name}: ${warning.message}`);
});

const ROOT = resolve(import.meta.dirname, '..', 'spikes');

/**
 * Proves the stripper still rejects what it is here to reject.
 *
 * This is the second check in this repository to turn out not to be checking
 * what it claimed, and both failed the same way: silently, with every file
 * passing. A stripper replaced by a no-op would produce exactly the output below
 * — twenty files, no complaints — so the detector is put against known input
 * before its verdict on the spikes is allowed to mean anything.
 */
function selfTest() {
  const mustAccept = [
    // The exact shape the old check reported as a syntax error.
    'const x: number = 1;\nconsole.log(x);\n',
    'const x: number = 1;\nexport const y = x;\n',
    'declare const s: unique symbol;\nexport type B<T> = T & { [s]: 1 };\n',
  ];
  const mustReject = [
    'enum Direction { Up }\nexport const d = Direction.Up;\n', // not erasable
    'namespace N { export const a = 1; }\n', //                    not erasable
    'const = ;\n', //                                             a real syntax error
  ];

  const failures = [];
  for (const sample of mustAccept) {
    try {
      stripTypeScriptTypes(sample, { mode: 'strip' });
    } catch (error) {
      failures.push(`rejected valid TypeScript: ${String(error.message).split('\n')[0]}`);
    }
  }
  for (const sample of mustReject) {
    let accepted = false;
    try {
      stripTypeScriptTypes(sample, { mode: 'strip' });
      accepted = true;
    } catch {
      // Expected.
    }
    if (accepted) failures.push(`accepted what it must reject: ${sample.split('\n')[0]}`);
  }

  if (failures.length > 0) {
    console.error('The type stripper is not behaving as this check assumes, so its verdict on');
    console.error('the spikes means nothing. It failed its own fixtures:\n');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  return mustAccept.length + mustReject.length;
}

const fixtures = selfTest();

/** Every .ts file under spikes/, excluding installed dependencies. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

let failures = 0;
const files = collect(ROOT);

/**
 * Names exported by the shared modules directly under spikes/, mapped to where
 * they come from. Used by check 3 below.
 */
const sharedExports = new Map();
for (const entry of readdirSync(ROOT)) {
  if (!entry.endsWith('.ts')) continue;
  const source = readFileSync(join(ROOT, entry), 'utf8');
  for (const m of source.matchAll(
    /export\s+(?:async\s+)?(?:function|const|let|class|type|interface)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    sharedExports.set(m[1], entry);
  }
}

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);

  const source = readFileSync(file, 'utf8');

  // 1. Does Node's type stripper accept it? This catches syntax errors and
  //    anything that is not erasable, which is what actually runs the file.
  try {
    stripTypeScriptTypes(source, { mode: 'strip' });
  } catch (error) {
    console.error(
      `FAIL  ${rel}\n  ${String(error.message).split('\n').slice(0, 3).join('\n  ')}\n`,
    );
    failures += 1;
    continue;
  }

  // 2. Does every name imported from a relative module actually exist there?
  //    This is the check that a linter cannot make and that the excluded
  //    typechecker would have made.
  const importRe = /import\s+\{([^}]+)\}\s+from\s+'(\.[^']+)'/g;
  for (const match of source.matchAll(importRe)) {
    const names = match[1]
      .split(',')
      .map((n) =>
        n
          .replace(/^\s*type\s+/, '')
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    const target = resolve(dirname(file), match[2]);
    let targetSource;
    try {
      targetSource = readFileSync(target, 'utf8');
    } catch {
      console.error(`FAIL  ${rel}: imports from '${match[2]}', which does not exist`);
      failures += 1;
      continue;
    }
    for (const name of names) {
      const exported = new RegExp(
        `export\\s+(?:async\\s+)?(?:function|const|let|class|type|interface)\\s+${name}\\b|export\\s*\\{[^}]*\\b${name}\\b`,
      ).test(targetSource);
      if (!exported) {
        console.error(
          `FAIL  ${rel}: imports '${name}' from '${match[2]}', which does not export it`,
        );
        failures += 1;
      }
    }
  }

  // 3. Is a name from a shared spike module USED here without being imported?
  //
  //    This is the check the whole script exists for, and the first version of
  //    it did not make. Verifying that imported names exist is the easy half;
  //    the defect that prompted this was the other half — a symbol used a
  //    hundred lines below an import list it had been dropped from.
  //
  //    It is a heuristic, not a typechecker: it only knows the names exported by
  //    the shared modules directly under spikes/. That is deliberate — those are
  //    the only imports the excluded typechecker could have resolved anyway, and
  //    a heuristic that catches the real defect beats a perfect check that needs
  //    every spike's dependencies installed in CI.
  const imported = new Set(
    [...source.matchAll(importRe)].flatMap((m) =>
      m[1]
        .split(',')
        .map((n) =>
          n
            .replace(/^\s*type\s+/, '')
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter(Boolean),
    ),
  );
  // A shared module obviously refers to its own exports without importing them.
  const isSharedModule = !rel.includes('/');
  if (!isSharedModule) {
    // Comments are stripped before looking for uses, because a name mentioned in
    // prose is not a use. This fired on a doc comment that said "deliberately not
    // called `MODEL`" — the check reporting an error for explaining why the error
    // does not apply. A check that goes off on prose is one people learn to
    // ignore, which costs more than the false positive does.
    const withoutImports = source
      .replace(importRe, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const [name, from] of sharedExports) {
      if (imported.has(name)) continue;
      if (new RegExp(`\\b${name}\\b`).test(withoutImports)) {
        console.error(`FAIL  ${rel}: uses '${name}' from ${from} without importing it`);
        failures += 1;
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} problem(s) in ${files.length} spike file(s).`);
  process.exit(1);
}
console.log(
  `Spike check passed: ${files.length} file(s) strip and resolve their local imports, ` +
    `stripper verified against ${fixtures} fixture(s).`,
);

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
 * resolution: it parses each spike with Node's own type stripper — the exact
 * mechanism that will run the file — and then checks that every identifier
 * imported from a relative module is actually exported by it.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'spikes');

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

  // 1. Does Node's type stripper accept it? This catches syntax errors and
  //    anything that is not erasable, which is what actually runs the file.
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', '--check', file], {
      stdio: 'pipe',
    });
  } catch (error) {
    const stderr = String(error.stderr ?? error)
      .split('\n')
      .slice(0, 3)
      .join('\n');
    console.error(`FAIL  ${rel}\n${stderr}\n`);
    failures += 1;
    continue;
  }

  // 2. Does every name imported from a relative module actually exist there?
  //    This is the check that a linter cannot make and that the excluded
  //    typechecker would have made.
  const source = readFileSync(file, 'utf8');
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
    const withoutImports = source.replace(importRe, '');
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
console.log(`Spike check passed: ${files.length} file(s) parse and resolve their local imports.`);

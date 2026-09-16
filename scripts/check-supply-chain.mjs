#!/usr/bin/env node
/**
 * Fails if the dependency cooling-off policy has been given an exception.
 *
 * pnpm 11 refuses to install a version published too recently, which is the
 * cheapest defence there is against a compromised release: most are noticed
 * and pulled within a day. Exceptions go in `minimumReleaseAgeExclude` in
 * `pnpm-workspace.yaml`.
 *
 * ## Why this exists
 *
 * On 2026-09-16, `pnpm add -D @anthropic-ai/claude-agent-sdk@0.3.273` did not
 * refuse. It wrote nine exclusion entries into `pnpm-workspace.yaml` — the
 * package and each of its platform binaries — and printed them in a list that
 * read exactly like an ordinary install, ending in `Done`. Nothing said the
 * policy had just been switched off for the one package that talks to a model
 * provider with this machine's credentials.
 *
 * It was noticed only because a diff showed a file nobody meant to edit. That
 * is not a control. This is: an exception now fails verification until a
 * person removes it, or deliberately teaches this script to accept it — which
 * is an edit to a file under review rather than a side effect of a command.
 *
 * The same shape as `allowBuilds`, where every entry is an explicit, commented
 * decision. The difference is that pnpm writes this one for you.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const KEY = 'minimumReleaseAgeExclude';

/**
 * The exclusion entries a workspace file declares, read by line.
 *
 * Line-based on purpose: the repository has no YAML parser at its root and this
 * check should not be the reason it gets one. The key is top-level, so a line
 * beginning with it opens the block, and the block's entries are the indented
 * `- ` lines that follow until the next unindented line.
 */
function exclusionsIn(source) {
  const lines = source.split(/\r?\n/);
  const found = [];
  let inside = false;
  for (const line of lines) {
    if (line.startsWith(`${KEY}:`)) {
      inside = true;
      // An inline list — `key: ['a']` — counts too.
      const inline = line.slice(KEY.length + 1).trim();
      if (inline !== '' && inline !== '[]') found.push(inline);
      continue;
    }
    if (!inside) continue;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inside = false;
      continue;
    }
    const entry = line.trim();
    if (entry.startsWith('- ')) found.push(entry.slice(2).trim());
  }
  return found;
}

/**
 * Proves the detector finds what it is here to find.
 *
 * Every check script in this directory tests itself before its verdict is
 * allowed to mean anything, because two of them have already reported a clean
 * result while detecting nothing. A reader that silently stopped matching the
 * key would print "no exceptions" forever.
 */
function selfTest() {
  const cases = [
    { source: 'allowBuilds:\n  esbuild: true\n', expect: 0 },
    { source: `${KEY}:\n  - 'a@1.0.0'\n  - 'b@2.0.0'\n`, expect: 2 },
    { source: `allowBuilds:\n  x: true\n\n${KEY}:\n  - 'a@1'\nother: 1\n`, expect: 1 },
    { source: `${KEY}: ['a@1']\n`, expect: 1 },
    { source: `${KEY}: []\n`, expect: 0 },
    { source: `${KEY}:\n  # why\n  - 'a@1'\n`, expect: 1 },
  ];
  const failures = cases.filter((c) => exclusionsIn(c.source).length !== c.expect);
  if (failures.length > 0) {
    console.error('The exclusion detector is not behaving as this check assumes, so its');
    console.error(`verdict means nothing. It failed ${failures.length} of its own fixtures.`);
    process.exit(1);
  }
  return cases.length;
}

const fixtures = selfTest();
const found = exclusionsIn(readFileSync(resolve(ROOT, 'pnpm-workspace.yaml'), 'utf8'));

if (found.length > 0) {
  console.error(`FAIL: the release-age cooling-off policy has ${found.length} exception(s):\n`);
  for (const entry of found) console.error(`  ${entry}`);
  console.error(
    '\npnpm writes these itself when asked for a version newer than the policy allows.\n' +
      'Remove them and install the newest version that passes, or — if an exception is\n' +
      'truly needed — make that decision visibly in this script, with the reason.\n',
  );
  process.exit(1);
}

console.log(
  `Supply-chain check passed: no release-age exceptions, detector verified against ${fixtures} fixture(s).`,
);

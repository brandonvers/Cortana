#!/usr/bin/env node
/**
 * Fails the build if a package that is not the designated adapter reaches for a
 * model provider's SDK.
 *
 * `docs/adr/0001-model-access-behind-a-port.md` is the reason this exists, and
 * it is worth restating because the rule looks like architectural taste and is
 * not. This project runs on a consumer subscription whose terms moved twice in
 * five months. The mitigation for that risk is that provider contact is confined
 * to one package, so that a change in terms rewrites one adapter instead of
 * migrating a codebase. That ADR has said "CI enforces it" since 2026-08-10, and
 * until this script existed, CI did not.
 *
 * The rule is per provider, not per prefix. ADR-0001 says *exactly one* package
 * may import a given provider's types — so a future `runner-openai` is not
 * entitled to import Anthropic's SDK just because its name starts with `runner`.
 * Each row below pins one provider module to one package.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', 'packages');

/** Provider module → the single internal package permitted to import it. */
const PROVIDER_MODULES = new Map([
  ['@anthropic-ai/claude-agent-sdk', '@cortana/runner-claude'],
  ['@anthropic-ai/claude-code', '@cortana/runner-claude'],
]);

/**
 * Comments are removed before specifiers are matched, so that a module named in
 * prose — "this is the only file that may import @anthropic-ai/claude-agent-sdk"
 * — is not reported as importing it. A check that fires on its own explanation
 * is one people learn to ignore.
 *
 * The `[^:]` guard keeps `https://` from being read as the start of a comment,
 * which is the same trick `check-spikes.mjs` uses for the same reason.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every module specifier the file pulls in, by any of the four forms that do it.
 *
 * This matches specifiers rather than parsing the module graph, and the limit
 * that follows is real: it sees a direct import and nothing else. A package that
 * re-exports provider types through an intermediary is invisible here. That is
 * recorded in the M1 plan as a known bound on the check rather than papered
 * over — a check trusted beyond what it inspects is worse than a narrow one.
 */
function specifiers(source) {
  const clean = stripComments(source);
  const found = new Set();
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g, //            import … from '…'  /  export … from '…'
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g, //     import('…')
    /\brequire\s*\(\s*['"]([^'"]+)['"]/g, //    require('…')
    /\bimport\s+['"]([^'"]+)['"]/g, //          import '…'   (side effect only)
  ];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

/** A specifier hits a provider module if it is that module or a subpath of it. */
function providerFor(specifier) {
  for (const module of PROVIDER_MODULES.keys()) {
    if (specifier === module || specifier.startsWith(`${module}/`)) return module;
  }
  return null;
}

/**
 * Proves the detector still detects, on every run.
 *
 * With no runner package written yet, the rule is trivially satisfied: the
 * repository would pass this check even if the matching were broken, and it
 * would keep passing right up until the moment it mattered. So the script
 * verifies itself against known-bad and known-good input before it is allowed to
 * report on the repository.
 */
function selfTest() {
  const mustCatch = [
    "import { query } from '@anthropic-ai/claude-agent-sdk';",
    "import type { Options } from '@anthropic-ai/claude-agent-sdk';",
    "export { query } from '@anthropic-ai/claude-agent-sdk';",
    "export * from '@anthropic-ai/claude-code';",
    "const sdk = await import('@anthropic-ai/claude-agent-sdk');",
    "const sdk = require('@anthropic-ai/claude-agent-sdk');",
    "import '@anthropic-ai/claude-agent-sdk';",
    "import { x } from '@anthropic-ai/claude-agent-sdk/tools';",
  ];
  const mustIgnore = [
    '// only runner-claude may import @anthropic-ai/claude-agent-sdk',
    '/* see @anthropic-ai/claude-agent-sdk for the shape of this */',
    "import { z } from 'zod';",
    "const url = 'https://example.invalid/@anthropic-ai/claude-agent-sdk';",
    "import { thing } from '@cortana/core';",
  ];

  const failures = [];
  for (const sample of mustCatch) {
    if (!specifiers(sample).some(providerFor)) failures.push(`missed:   ${sample}`);
  }
  for (const sample of mustIgnore) {
    if (specifiers(sample).some(providerFor)) failures.push(`flagged:  ${sample}`);
  }
  if (failures.length > 0) {
    console.error('The boundary detector is broken, so its verdict on this repository means');
    console.error('nothing. It failed its own fixtures:\n');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  return mustCatch.length + mustIgnore.length;
}

/** Every source file under a package, excluding installed dependencies. */
function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(entry)) out.push(full);
  }
  return out;
}

function packageNames() {
  const names = new Map();
  for (const entry of readdirSync(ROOT)) {
    const manifest = join(ROOT, entry, 'package.json');
    try {
      names.set(entry, JSON.parse(readFileSync(manifest, 'utf8')));
    } catch {
      // A directory under packages/ without a manifest is not a package.
    }
  }
  return names;
}

const fixtures = selfTest();
const manifests = packageNames();
const violations = [];

// 1. Declaring the dependency is a violation on its own. A package that lists a
//    provider SDK has already crossed the boundary in the file that matters for
//    supply chain and install size, whether or not any import exists yet.
for (const [dir, manifest] of manifests) {
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
  for (const specifier of Object.keys(declared)) {
    const provider = providerFor(specifier);
    if (!provider) continue;
    const allowed = PROVIDER_MODULES.get(provider);
    if (manifest.name !== allowed) {
      violations.push({
        file: `packages/${dir}/package.json`,
        specifier: provider,
        owner: manifest.name ?? dir,
        allowed,
        how: 'declares it as a dependency',
      });
    }
  }
}

// 2. Importing it.
for (const [dir, manifest] of manifests) {
  for (const file of collect(join(ROOT, dir))) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiers(source)) {
      const provider = providerFor(specifier);
      if (!provider) continue;
      const allowed = PROVIDER_MODULES.get(provider);
      if (manifest.name !== allowed) {
        violations.push({
          file: file.slice(resolve(ROOT, '..').length + 1),
          specifier,
          owner: manifest.name ?? dir,
          allowed,
          how: 'imports it',
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Provider boundary violated. See docs/adr/0001-model-access-behind-a-port.md.\n');
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.owner} ${v.how}: ${v.specifier}`);
    console.error(`    Only ${v.allowed} may. Put the code behind the ModelRunner port instead.\n`);
  }
  console.error(
    'The port exists because provider terms have changed twice. Keeping contact in\n' +
      'one package is what makes the next change one rewrite instead of a migration.\n',
  );
  process.exit(1);
}

const scanned = [...manifests.keys()].length;
console.log(
  `Boundary check passed: ${scanned} package(s), ${PROVIDER_MODULES.size} provider module(s) ` +
    `confined, detector verified against ${fixtures} fixture(s).`,
);

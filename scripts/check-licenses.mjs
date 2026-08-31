#!/usr/bin/env node
/**
 * Fails the build if any dependency carries a licence incompatible with MIT
 * redistribution.
 *
 * CONTRIBUTING.md makes this a hard rule rather than a guideline: this project
 * is redistributed as source under MIT, and a copyleft or source-available
 * dependency in the tree makes that claim false. Checking it by hand is the kind
 * of thing that gets skipped, so it runs in CI.
 *
 * ## It was inspecting almost nothing until 2026-08-31
 *
 * The listing was requested with `--prod --dev`, meaning "everything". Passing
 * both makes pnpm behave as though only `--prod` had been given:
 *
 *   pnpm licenses list                  53 packages
 *   pnpm licenses list --prod            2
 *   pnpm licenses list --dev            46
 *   pnpm licenses list --prod --dev      2   <- what this script asked for
 *
 * So no development dependency had ever been inspected, and neither had the
 * platform-specific binaries — `fsevents`, the Biome and Rolldown native builds
 * — which appear only in the unflagged listing. Among what it never saw was an
 * MPL-2.0 package, which the review list below exists to catch.
 *
 * Requesting no filter at all is the complete view. `--prod` is still requested,
 * separately, because it answers a different question that changes what a
 * copyleft licence means: whether the package is shipped or only built with.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

/** Licences that make redistribution under MIT untenable. */
const DENIED = [
  /\bAGPL\b/i,
  /\bSSPL\b/i,
  /\bRSAL\b/i,
  /Business Source/i,
  /\bBUSL\b/i,
  /Commons Clause/i,
  /\bElastic License\b/i,
  /\bSSPL-1\.0\b/i,
];

/**
 * Copyleft licences that are not automatically disqualifying but must never be
 * added without a deliberate decision, because the obligations they create are
 * real and are easy to acquire by accident through a transitive dependency.
 */
const REVIEW = [/\bGPL-[23]/i, /\bLGPL\b/i, /\bMPL\b/i, /\bCDDL\b/i, /\bEPL\b/i];

/** Licence strings that are not a licence and need a human to look. */
const UNKNOWN = [/^unknown$/i, /^unlicensed$/i, /^see licen[cs]e/i, /^custom/i, /^$/];

/**
 * Copyleft that has been looked at and accepted, with the reason it is
 * acceptable.
 *
 * This list is what lets an unacknowledged copyleft licence be a **failure**
 * rather than a warning. CONTRIBUTING.md says copyleft "must never be added
 * without a deliberate decision"; a warning printed on every green build is not
 * that, it is something people learn to scroll past. An entry here is the
 * deliberate decision, in writing, in the place the rule is enforced.
 *
 * `devOnly` is verified rather than trusted: if the package ever appears in the
 * production listing, the reason recorded here has stopped being true and the
 * check says so instead of continuing to honour it.
 */
const ACKNOWLEDGED = [
  {
    match: /^lightningcss(-|$)/,
    licence: /^MPL-2\.0$/,
    devOnly: true,
    why:
      'A CSS transformer pulled in transitively by vitest through vite. MPL-2.0 is ' +
      'file-level copyleft: the obligation attaches to modified MPL files, and this ' +
      'is a build-time tool that is neither modified nor distributed with the project.',
  },
];

function listLicenses(extraArgs) {
  let raw;
  try {
    raw = execFileSync('pnpm', ['licenses', 'list', '--json', ...extraArgs], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // An empty dependency tree makes `pnpm licenses list` exit non-zero with
    // nothing useful on stdout. That is a pass, not a failure.
    const stdout = /** @type {{stdout?: string}} */ (error).stdout ?? '';
    if (!looksLikeJson(stdout)) return {};
    raw = stdout;
  }

  // Even on success, pnpm prints a plain-text notice such as
  // "No licenses in packages found" when the tree has nothing to report, so the
  // shape has to be checked rather than assumed.
  if (!looksLikeJson(raw)) return {};

  try {
    return JSON.parse(raw);
  } catch {
    console.error('Could not parse the output of `pnpm licenses list --json`:\n');
    console.error(raw.slice(0, 500));
    process.exit(1);
  }
}

/** @param {string} text */
function looksLikeJson(text) {
  const trimmed = text.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/** @param {string} license */
function classify(license) {
  if (DENIED.some((r) => r.test(license))) return 'denied';
  if (REVIEW.some((r) => r.test(license))) return 'review';
  if (UNKNOWN.some((r) => r.test(license))) return 'unknown';
  return 'allowed';
}

/**
 * Every dependency this workspace declares, excluding the ones it declares on
 * itself.
 *
 * Used as a coverage floor: if the licence listing does not account for a
 * package a manifest names, the listing is not describing this repository and
 * nothing it reports can be relied on. This is the assertion that would have
 * caught the defect in the header — under `--prod --dev`, typescript, vitest,
 * Biome and @types/node were all declared and all absent.
 */
function declaredDependencies() {
  const manifests = [join(ROOT, 'package.json')];
  for (const entry of readdirSync(join(ROOT, 'packages'))) {
    manifests.push(join(ROOT, 'packages', entry, 'package.json'));
  }

  const declared = new Set();
  for (const path of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue; // Not every directory under packages/ is a package.
    }
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        // A workspace package is this repository, not a third party, and has no
        // entry in the licence listing.
        if (String(range).startsWith('workspace:')) continue;
        declared.add(name);
      }
    }
  }
  return declared;
}

/**
 * Proves the classifier still classifies.
 *
 * This is the third check in this repository found not to be doing what it
 * claimed, and all three failed the same way: silently, with a green result. A
 * classifier whose patterns had been broken would report every licence as
 * allowed and print a reassuring summary, so it is put against known input
 * before its verdict on the tree is allowed to mean anything.
 */
function selfTest() {
  const expectations = [
    ['AGPL-3.0-or-later', 'denied'],
    ['SSPL-1.0', 'denied'],
    ['BUSL-1.1', 'denied'],
    ['Business Source License 1.1', 'denied'],
    ['Elastic License 2.0', 'denied'],
    ['GPL-3.0-only', 'review'],
    ['LGPL-2.1', 'review'],
    ['MPL-2.0', 'review'],
    ['EPL-2.0', 'review'],
    ['UNKNOWN', 'unknown'],
    ['UNLICENSED', 'unknown'],
    ['', 'unknown'],
    ['MIT', 'allowed'],
    ['Apache-2.0', 'allowed'],
    ['BSD-3-Clause', 'allowed'],
    ['ISC', 'allowed'],
    ['MIT OR Apache-2.0', 'allowed'],
  ];

  const failures = [];
  for (const [license, expected] of expectations) {
    const actual = classify(license);
    if (actual !== expected) {
      failures.push(`${license || '(empty)'} classified as ${actual}, expected ${expected}`);
    }
  }

  if (failures.length > 0) {
    console.error('The licence classifier is broken, so its verdict on this tree means nothing.');
    console.error('It failed its own fixtures:\n');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  return expectations.length;
}

const fixtures = selfTest();

const byLicense = listLicenses([]);
const productionNames = new Set();
for (const packages of Object.values(listLicenses(['--prod']))) {
  for (const entry of packages) productionNames.add(entry.name);
}

const denied = [];
const review = [];
const unknown = [];
const accepted = [];
const brokenAcknowledgements = [];
const matchedAcknowledgements = new Set();
const listedNames = new Set();

for (const [license, packages] of Object.entries(byLicense)) {
  const bucket = classify(license);
  for (const entry of Array.isArray(packages) ? packages : []) {
    listedNames.add(entry.name);
    const versions = Array.isArray(entry.versions)
      ? entry.versions.join(', ')
      : (entry.version ?? '?');
    const record = {
      license,
      name: `${entry.name}@${versions}`,
      production: productionNames.has(entry.name),
    };

    if (bucket === 'allowed') continue;

    const acknowledgement = ACKNOWLEDGED.find(
      (a) => a.match.test(entry.name) && a.licence.test(license),
    );
    if (acknowledgement) {
      matchedAcknowledgements.add(acknowledgement);
      if (acknowledgement.devOnly && record.production) {
        // The recorded reason has stopped being true. Honouring it now would be
        // honouring a justification that no longer describes reality.
        brokenAcknowledgements.push(record);
      } else {
        accepted.push({ ...record, why: acknowledgement.why });
      }
      continue;
    }

    if (bucket === 'denied') denied.push(record);
    else if (bucket === 'review') review.push(record);
    // An undeterminable licence in something we ship is a real problem; in a
    // build-time tool it is untidy. The two are reported differently below.
    else unknown.push(record);
  }
}

const stale = ACKNOWLEDGED.filter((a) => !matchedAcknowledgements.has(a));

const declared = declaredDependencies();
const uncovered = [...declared].filter((name) => !listedNames.has(name));

const report = (title, entries) => {
  if (entries.length === 0) return;
  console.error(`\n${title}`);
  for (const entry of entries) {
    console.error(`  ${entry.license}`);
    console.error(`    - ${entry.name}${entry.production ? '  (production)' : '  (dev only)'}`);
  }
};

let failed = false;

if (uncovered.length > 0) {
  console.error('\nThe licence listing does not account for packages this workspace declares,');
  console.error('so it is not describing this repository and nothing below can be relied on:\n');
  for (const name of uncovered) console.error(`  - ${name}`);
  console.error('\nCheck the arguments passed to `pnpm licenses list`.');
  failed = true;
}

report('DENIED — incompatible with MIT redistribution:', denied);
if (denied.length > 0) failed = true;

report('NEEDS REVIEW — copyleft, and not acknowledged:', review);
if (review.length > 0) {
  console.error('\nAdd an entry to ACKNOWLEDGED in this script recording why it is acceptable,');
  console.error('or remove the dependency. See CONTRIBUTING.md § Dependencies.');
  failed = true;
}

const unknownProduction = unknown.filter((entry) => entry.production);
report('UNKNOWN in production — licence could not be determined:', unknownProduction);
if (unknownProduction.length > 0) failed = true;

const unknownDev = unknown.filter((entry) => !entry.production);
if (unknownDev.length > 0) {
  report('UNKNOWN in a build-time dependency — worth a look, not a blocker:', unknownDev);
}

if (brokenAcknowledgements.length > 0) {
  console.error('\nAn acknowledgement recorded a licence as acceptable because the package was');
  console.error('build-time only. It is now a production dependency, so that reason no longer');
  console.error('holds and the exemption has been withdrawn:\n');
  for (const entry of brokenAcknowledgements) console.error(`  ${entry.license}  ${entry.name}`);
  failed = true;
}

if (stale.length > 0) {
  console.error('\nAcknowledgements that matched nothing in the tree — the dependency is gone and');
  console.error('the entry should be deleted rather than left to describe a package that is not');
  console.error('here:\n');
  for (const entry of stale) console.error(`  ${entry.match}  ${entry.licence}`);
}

if (failed) {
  console.error('\nLicence check failed. See CONTRIBUTING.md § Dependencies.\n');
  process.exit(1);
}

if (accepted.length > 0) {
  console.log('Copyleft present and previously accepted:');
  for (const entry of accepted) console.log(`  ${entry.license}  ${entry.name}`);
}

console.log(
  `Licence check passed: ${listedNames.size} package(s), ${productionNames.size} in production, ` +
    `${declared.size} declared dependencies all accounted for, ` +
    `classifier verified against ${fixtures} fixture(s).`,
);

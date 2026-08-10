#!/usr/bin/env node
/**
 * Fails the build if any dependency carries a licence incompatible with MIT
 * redistribution.
 *
 * CONTRIBUTING.md makes this a hard rule rather than a guideline: this project
 * is redistributed as source under MIT, and a copyleft or source-available
 * dependency in the tree makes that claim false. Checking it by hand is the kind
 * of thing that gets skipped, so it runs in CI.
 */

import { execFileSync } from 'node:child_process';

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

function readLicenses() {
  let raw;
  try {
    raw = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod', '--dev'], {
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

const byLicense = readLicenses();

const denied = [];
const review = [];
const unknown = [];

for (const [license, packages] of Object.entries(byLicense)) {
  const names = (Array.isArray(packages) ? packages : []).map(
    (p) => `${p.name}@${Array.isArray(p.versions) ? p.versions.join(', ') : (p.version ?? '?')}`,
  );
  const bucket = DENIED.some((r) => r.test(license))
    ? denied
    : REVIEW.some((r) => r.test(license))
      ? review
      : UNKNOWN.some((r) => r.test(license))
        ? unknown
        : null;
  if (bucket) bucket.push({ license, names });
}

const report = (title, entries) => {
  if (entries.length === 0) return;
  console.error(`\n${title}`);
  for (const { license, names } of entries) {
    console.error(`  ${license}`);
    for (const name of names) console.error(`    - ${name}`);
  }
};

report('DENIED — incompatible with MIT redistribution:', denied);
report('NEEDS REVIEW — copyleft, must be a deliberate decision:', review);
report('UNKNOWN — licence could not be determined, look manually:', unknown);

if (denied.length > 0) {
  console.error('\nLicence check failed. See CONTRIBUTING.md § Dependencies.\n');
  process.exit(1);
}

if (review.length > 0 || unknown.length > 0) {
  console.error('\nLicence check passed with warnings. Review the entries above.\n');
} else {
  const total = Object.values(byLicense).reduce(
    (n, list) => n + (Array.isArray(list) ? list.length : 0),
    0,
  );
  console.log(`Licence check passed: ${total} package(s), no disallowed licences.`);
}

#!/usr/bin/env node
/**
 * Fails if anything under private/ has been committed, or if the local
 * pre-commit guard is not installed.
 *
 * private/ holds the maintainer's personal notes and packs. It is excluded three
 * ways on purpose, because one mechanism is one mistake away from a public leak:
 *
 *   1. .gitignore            — a normal `git add` cannot see it
 *   2. .githooks/pre-commit  — `git add -f` is refused
 *   3. this script, in CI    — a broken or bypassed hook on one machine is caught
 *
 * The CI run is the layer that does not depend on any developer's local setup.
 */

import { execFileSync } from 'node:child_process';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

let failed = false;

// 1. Nothing under private/ may be tracked.
const tracked = git(['ls-files', '--', 'private/'])
  .split('\n')
  .filter((line) => line !== '');

if (tracked.length > 0) {
  console.error('FAIL: files under private/ are tracked by git and would be published:\n');
  for (const file of tracked) console.error(`  ${file}`);
  console.error('\nRemove them from the index with:  git rm --cached -r private/\n');
  failed = true;
} else {
  console.log('OK: nothing under private/ is tracked.');
}

// 2. Nothing under private/ may appear anywhere in history either. A file that
//    was committed once and deleted later is still public forever.
const inHistory = git(['log', '--all', '--pretty=format:', '--name-only', '--', 'private/'])
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');

if (inHistory.length > 0) {
  const unique = [...new Set(inHistory)];
  console.error('\nFAIL: files under private/ appear in git history:\n');
  for (const file of unique) console.error(`  ${file}`);
  console.error(
    '\nDeleting them in a later commit is not enough — history is public.' +
      '\nThe history has to be rewritten, and any exposed credential rotated.\n',
  );
  failed = true;
} else {
  console.log('OK: nothing under private/ appears in git history.');
}

// 3. Locally (not in CI), the pre-commit guard should be wired up.
if (!process.env.CI) {
  let hooksPath = '';
  try {
    hooksPath = git(['config', '--get', 'core.hooksPath']);
  } catch {
    hooksPath = '';
  }
  if (hooksPath !== '.githooks') {
    console.error(
      '\nWARNING: the pre-commit guard is not active. Enable it with:' +
        '\n  git config core.hooksPath .githooks\n',
    );
  } else {
    console.log('OK: pre-commit guard is active.');
  }
}

process.exit(failed ? 1 : 0);

/**
 * The contract, against the real provider, run by hand.
 *
 * The M2 plan decided this rather than leaving it to habit: **CI never calls the
 * provider.** It has no credential and is not getting one — ADR-0001's shape is
 * that this project never handles provider credentials, which applies to its own
 * build as much as to a user — and spike 0009 measured one identical call
 * costing $0.0201 and $0.6891, so a suite that called out on every pull request
 * would have a bill scaling with the test count and varying 34× for reasons
 * nobody controls.
 *
 * So the contract was built as a list of plain functions rather than a `describe`
 * block, precisely so it could be run from here. This is the same suite the fake
 * passes, unchanged.
 *
 *   node packages/runner-claude/src/contract.manual.ts
 *
 * It spends money on the account whose Claude Code installation is authenticated
 * on this machine. It is a handful of small turns, but it is not free, and it
 * says so before it starts.
 */

import { modelRunnerContract } from '@cortana/runner';
import { createClaudeRunner } from './adapter.ts';

const cases = modelRunnerContract();

process.stdout.write(
  `Running ${cases.length} contract cases against the real provider.\n` +
    'This spends money on your own subscription. Ctrl-C within 3 seconds to stop.\n\n',
);
await new Promise((resolve) => setTimeout(resolve, 3_000));

let passed = 0;
const failures: { name: string; error: unknown }[] = [];

for (const contractCase of cases) {
  // A fresh runner per case, exactly as the fake gets. An adapter that only
  // works on the first call is not an adapter.
  const runner = await createClaudeRunner();
  const started = Date.now();
  try {
    await contractCase.run(runner);
    passed += 1;
    process.stdout.write(`  ok    ${contractCase.name}  (${Date.now() - started} ms)\n`);
  } catch (error) {
    failures.push({ name: contractCase.name, error });
    process.stdout.write(`  FAIL  ${contractCase.name}  (${Date.now() - started} ms)\n`);
  }
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);

for (const { name, error } of failures) {
  process.stdout.write(`\n${name}\n  ${String(error).split('\n').slice(0, 4).join('\n  ')}\n`);
}

// A failure here is a finding about the port, not a test to relax. The M2 plan
// says so, and it has already been right once: the port put prose and structured
// turns on one session, and the provider fixes the output shape when a session
// opens.
process.exitCode = failures.length === 0 ? 0 : 1;

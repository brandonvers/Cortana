/**
 * Whether a conversation continues across processes, run by hand against the
 * real provider.
 *
 *   node packages/runner-claude/src/resume.manual.ts
 *
 * Every deploy restarts the daemon, and until working material's step 2 every
 * restart was the agent forgetting the conversation. The port now carries a
 * token that continues a session; this is the measurement that it does, taken
 * the way the other manual scripts take theirs — with a control first.
 *
 * - **told** — a session is given a word to remember, and its token is kept.
 * - **control** — a new session, not continued, is asked for the word. If it
 *   knows it, the word was guessable or leaked by some other route, and the
 *   last arm proves nothing; the script says so rather than printing a pass.
 * - **continued** — a runner made afresh, so a new provider process, opens a
 *   session with the token and is asked for the word.
 *
 * It spends money on the account whose Claude Code installation is
 * authenticated on this machine: three short turns on the fast tier.
 */

import type { Profile } from '@cortana/policy';
import { createClaudeRunner } from './adapter.ts';

const WORD = `HERON-${Math.floor(Math.random() * 1e6)}`;

const SEALED: Profile = {
  name: 'resume',
  trust: 'system',
  tools: [],
  readable: [],
  writable: [],
  denyRead: [],
  network: 'allowed',
  sandbox: 'none',
  confirm: 'never',
};
const spec = { tier: 'fast' as const, systemPrompt: 'Answer in one short line.', profile: SEALED };
const ASK = 'What was the code word I gave you earlier? If none, reply NONE.';

process.stdout.write(
  'Whether a conversation continues in a new provider process.\n' +
    'This spends money on your own subscription. Ctrl-C within 3 seconds to stop.\n\n',
);
await new Promise((resolve) => setTimeout(resolve, 3_000));

const told = await (await createClaudeRunner()).start(spec);
await told.turn(`Remember this code word: ${WORD}. Reply OK.`);
const token = told.resumeToken;
await told.stop();
process.stdout.write(`  told        token=${token === null ? 'none' : 'issued'}\n`);

let failures = 0;
if (token === null) {
  process.stdout.write('\nThe session issued no token, so there is nothing to continue.\n');
  failures += 1;
} else {
  const fresh = await (await createClaudeRunner()).start(spec);
  const control = (await fresh.turn(ASK)).text;
  await fresh.stop();
  const leaked = control.includes(WORD);
  process.stdout.write(`  control     knew=${leaked}  ${control.trim().slice(0, 60)}\n`);

  if (leaked) {
    process.stdout.write(
      '\nA session that was not continued knew the word, so the arm below would pass\n' +
        'for the wrong reason. Fix the control before reading on.\n',
    );
    failures += 1;
  } else {
    const resumed = await (await createClaudeRunner()).start({ ...spec, resume: token });
    const answer = (await resumed.turn(ASK)).text;
    await resumed.stop();
    const knew = answer.includes(WORD);
    failures += knew ? 0 : 1;
    process.stdout.write(
      `  ${knew ? 'continued' : 'FORGOTTEN'}   knew=${knew}  ${answer.trim().slice(0, 60)}\n`,
    );
  }
}

process.stdout.write(failures === 0 ? '\nContinued.\n' : `\n${failures} problem(s).\n`);
process.exitCode = failures === 0 ? 0 : 1;

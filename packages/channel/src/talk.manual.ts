/**
 * A conversation with a running daemon, from a terminal.
 *
 * The M3 plan says what this is: the socket is "the transport the ops CLI needs
 * anyway", and this is the smallest thing that proves it. It is **not** the CLI
 * — that is M7 — and it is deliberately not on the `bin` list of any package,
 * so nobody installs it by accident and starts depending on its output.
 *
 *   node packages/channel/src/talk.manual.ts "hello" "what did I just say?"
 *   CORTANA_DATA_DIR=/var/lib/cortana node packages/channel/src/talk.manual.ts "hello"
 *
 * With no arguments it reads lines from standard input, which is what makes it
 * usable as a conversation rather than as one shot.
 *
 * **Approvals are refused by default and the flag to change that is spelled
 * out.** A client that said yes on its own behalf would be answering for the
 * person it stands in for, which is the one thing an approval exists to prevent.
 * `--approve` is for someone who has decided to accept everything this session
 * proposes, and having to type it is the point.
 */

import { createInterface } from 'node:readline';
import { loadConfig } from '@cortana/config';
import { isAppError } from '@cortana/core';
import { connect } from './client.ts';
import { socketPathFor } from './server.ts';

const argv = process.argv.slice(2);
const approveEverything = argv.includes('--approve');
const lines = argv.filter((argument) => argument !== '--approve');

const { config } = loadConfig(process.env);
const path = socketPathFor(config.dataDir);

const client = await connect({
  path,
  onAsk: (question, because) => {
    process.stdout.write(
      `\n  ${question}\n  (${because})\n  → ${approveEverything ? 'yes' : 'no'}\n\n`,
    );
    return approveEverything;
  },
}).catch((error: unknown) => {
  // The one failure with an obvious cause and an obvious fix, so it gets a
  // sentence rather than a stack trace.
  if (isAppError(error) && error.category === 'unavailable') {
    process.stderr.write(`${error.message}\nIs the daemon running?\n`);
    process.exit(1);
  }
  throw error;
});

/**
 * One message, and its answer — or the reason there was not one.
 *
 * A failed turn is an error frame, which is correct: the turn failed. It is not
 * a reason to end this process with a stack trace naming lines in `client.ts`,
 * because the person's problem is never in `client.ts`. The daemon on the
 * deployment target reported "Not logged in · Please run /login" and this
 * printed seven frames of an async iterator instead.
 */
async function ask(text: string): Promise<void> {
  try {
    process.stdout.write(`${await client.say(text)}\n`);
  } catch (error) {
    if (isAppError(error)) {
      process.stdout.write(`! ${error.message}\n`);
      return;
    }
    throw error;
  }
}

if (lines.length > 0) {
  for (const line of lines) {
    process.stdout.write(`> ${line}\n`);
    await ask(line);
    process.stdout.write('\n');
  }
  client.close();
} else {
  process.stdout.write(`talking to ${path}. Ctrl-D to stop.\n`);
  const input = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  input.prompt();
  input.on('line', async (line) => {
    if (line.trim() !== '') await ask(line);
    input.prompt();
  });
  input.on('close', () => client.close());
}

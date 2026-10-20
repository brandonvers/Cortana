/**
 * `cortana`: talking to a running daemon from a terminal.
 *
 *   cortana "hello"            one message, its answer, and out
 *   cortana                    a conversation, until Ctrl-D
 *   echo "hello" | cortana     one message per line of input
 *
 * It grew out of `talk.manual.ts`, which M3 kept off every `bin` list so nobody
 * would start depending on it. First use is where depending on it starts, so it
 * is a command now, and two things changed on the way.
 *
 * ## A question is put to the person, when there is one
 *
 * An approval the policy engine will not decide on its own arrives on the
 * socket as a question. The manual script refused every one unless started
 * with `--approve`, because a client that said yes on its own would be
 * answering for the person it stands in for. That is still the rule — but at a
 * terminal there *is* a person, so the question is asked, and anything but a
 * yes is a no. When nobody is at the keyboard (input piped, or a script) it is
 * refused, as before, and `--approve` still exists for someone who has decided
 * to accept everything a session proposes and is willing to type that.
 *
 * ## A failure is a sentence
 *
 * The socket lives in the daemon's data directory, which is `0700` and belongs
 * to whoever the daemon runs as — the whole of the socket's authentication. So
 * on a server, the person at the terminal usually is not allowed in, and the
 * configuration that says where the socket is belongs to the service as well.
 * Both are the system working, and both get a sentence naming what to run
 * instead, not a stack trace.
 */

import { createInterface, type Interface } from 'node:readline/promises';
import { type Config, loadConfig } from '@cortana/config';
import { type AppError, isAppError, PRODUCT_NAME } from '@cortana/core';
import { connect } from './client.ts';
import { socketPathFor } from './server.ts';

const COMMAND = PRODUCT_NAME.toLowerCase();

export const EXIT_CODES = { ok: 0, failed: 1, config: 2 } as const;

export interface CliIo {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  readonly errors: NodeJS.WritableStream;
  /** Whether a person is at the keyboard — the only case a question can be put to one. */
  readonly interactive: boolean;
}

const USAGE = `usage: ${COMMAND} [--approve] [message ...]

  ${COMMAND} "hello"     send one message and print the answer
  ${COMMAND}             talk until Ctrl-D (one message per line)

  --approve   say yes to every approval this session asks for, unseen
`;

export async function runCli(io: CliIo): Promise<number> {
  const args = io.argv.filter((argument) => argument !== '--approve');
  const approveEverything = args.length !== io.argv.length;
  if (args.includes('--help') || args.includes('-h')) {
    io.output.write(USAGE);
    return EXIT_CODES.ok;
  }

  let config: Config;
  try {
    config = loadConfig(io.env).config;
  } catch (error) {
    if (!isAppError(error)) throw error;
    io.errors.write(`${error.message}\n`);
    if (error.code === 'config-file-unreadable') io.errors.write(asTheService());
    return EXIT_CODES.config;
  }
  const path = socketPathFor(config.dataDir);

  // One reader for the whole session, so a question asked in the middle of a
  // turn and the next message are read from the same place in order.
  const reader = createInterface({
    input: io.input,
    output: io.output,
    terminal: false,
  });
  const line = lineReader(reader, io.output);

  let client: Awaited<ReturnType<typeof connect>>;
  try {
    client = await connect({
      path,
      onAsk: async (question, because) => {
        io.output.write(`\n  ${question}\n  (${because})\n`);
        if (approveEverything) {
          io.output.write('  → yes (--approve)\n\n');
          return true;
        }
        if (!io.interactive) {
          io.output.write('  → no: nobody is at the keyboard to say yes\n\n');
          return false;
        }
        const answer = (await line('  Allow it? [y/N] ')) ?? '';
        const approved = /^(y|yes)$/i.test(answer.trim());
        io.output.write(approved ? '  → yes\n\n' : '  → no\n\n');
        return approved;
      },
    });
  } catch (error) {
    reader.close();
    if (!isAppError(error) || error.category !== 'unavailable') throw error;
    io.errors.write(`${error.message}\n${whyUnreachable(error)}`);
    return EXIT_CODES.failed;
  }

  let failed = false;
  const send = async (text: string): Promise<void> => {
    try {
      io.output.write(`${await client.say(text)}\n`);
    } catch (error) {
      // A failed turn is the daemon's answer, not this process's crash: the
      // person's problem is never in this file.
      if (!isAppError(error)) throw error;
      failed = true;
      io.output.write(`! ${error.message}\n`);
    }
  };

  try {
    if (args.length > 0) {
      for (const message of args) await send(message);
    } else {
      if (io.interactive) io.output.write(`talking to ${path}. Ctrl-D to stop.\n`);
      for (;;) {
        const text = await line(io.interactive ? '> ' : '');
        if (text === null) break;
        if (text.trim() !== '') await send(text);
      }
    }
  } finally {
    client.close();
    reader.close();
  }
  return failed ? EXIT_CODES.failed : EXIT_CODES.ok;
}

/**
 * The next line, or `null` at the end of input, after showing the prompt.
 *
 * Lines that arrive before anybody asks are kept rather than dropped: piped
 * input arrives all at once, and a reader that only listened while asking
 * would lose every message after the first. The prompt is written either way —
 * a question answered by a line typed ahead is still a question that was asked.
 */
function lineReader(
  reader: Interface,
  output: NodeJS.WritableStream,
): (prompt: string) => Promise<string | null> {
  const ready: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let closed = false;
  reader.on('line', (text) => {
    const next = waiting.shift();
    if (next) next(text);
    else ready.push(text);
  });
  reader.on('close', () => {
    closed = true;
    for (const next of waiting.splice(0)) next(null);
  });
  return (prompt) => {
    if (prompt !== '') output.write(prompt);
    const text = ready.shift();
    if (text !== undefined) return Promise.resolve(text);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiting.push(resolve));
  };
}

/** What to do about a socket that would not take the connection. */
function whyUnreachable(error: AppError): string {
  const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM') return asTheService();
  return 'Is the daemon running?\n';
}

/**
 * Where to go instead. Not `sudo -u cortana` on its own: run that way the
 * daemon's data directory is not where the service keeps it — systemd tells the
 * service through `STATE_DIRECTORY`, and nobody tells a shell — so the wrapper
 * installed with the service says it, and this points at the wrapper.
 */
function asTheService(): string {
  return (
    'The socket and its configuration belong to the user the daemon runs as.\n' +
    `On the server, use the \`${COMMAND}\` command installed with the service, which ` +
    'runs this as that user (packages/daemon/packaging/cortana).\n'
  );
}

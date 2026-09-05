/**
 * The other end.
 *
 * Small on purpose: it is the thing M7's ops CLI grows out of, and a client that
 * has opinions now is a client that has the wrong ones later. What it does is
 * connect, send a line, and hand back what comes.
 *
 * The one thing it must do properly is answer questions. A daemon that asks
 * before acting is only useful if something is listening for the asking, and a
 * client that ignored `ask` frames would leave every approval to time out into a
 * refusal — the system would appear to work and would silently do nothing.
 */

import { createConnection, type Socket } from 'node:net';
import { AppError } from '@cortana/core';
import { encode, MAX_FRAME_BYTES, type ServerFrame } from './protocol.ts';

export interface ClientOptions {
  readonly path: string;
  /**
   * Answers a question from the daemon.
   *
   * There is no default. A client that decided approvals on its own behalf
   * would be answering for the person it is standing in for, and the whole point
   * of an approval is that a person is asked.
   */
  readonly onAsk: (question: string, because: string) => Promise<boolean> | boolean;
}

export interface Client {
  /** Sends a message and resolves with the reply. */
  say(text: string): Promise<string>;
  close(): void;
}

export async function connect(options: ClientOptions): Promise<Client> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const attempt = createConnection(options.path);
    attempt.once('connect', () => resolve(attempt));
    attempt.once('error', (error) =>
      reject(
        new AppError(`cannot reach the daemon on ${options.path}`, {
          category: 'unavailable',
          code: 'channel-unreachable',
          detail: { path: options.path },
          cause: error,
        }),
      ),
    );
  });
  socket.setEncoding('utf8');

  const waiting = new Map<string, (frame: ServerFrame) => void>();
  let buffer = '';
  let sent = 0;

  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_FRAME_BYTES) {
      socket.destroy();
      return;
    }
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line.trim() === '') continue;

      let frame: ServerFrame;
      try {
        frame = JSON.parse(line) as ServerFrame;
      } catch {
        continue;
      }

      if (frame.type === 'ask') {
        void (async () => {
          const approved = await options.onAsk(frame.question, frame.because);
          socket.write(encode({ type: 'answer', id: frame.id, approved }));
        })();
        continue;
      }
      waiting.get(frame.id)?.(frame);
    }
  });

  const failEverything = (reason: string) => {
    for (const settle of waiting.values()) {
      settle({ type: 'error', id: '', message: reason });
    }
    waiting.clear();
  };
  socket.on('close', () => failEverything('the daemon closed the connection'));
  socket.on('error', (error) => failEverything(String(error)));

  return {
    say(text: string): Promise<string> {
      sent += 1;
      const id = `say-${sent}`;
      return new Promise<string>((resolve, reject) => {
        waiting.set(id, (frame) => {
          waiting.delete(id);
          if (frame.type === 'reply') resolve(frame.text);
          else if (frame.type === 'error') {
            reject(
              // The daemon's own sentence, unwrapped. Prefixing it buried the
              // part that mattered behind two class names and a clause about
              // this client, and the category is the daemon's rather than a
              // guess: `internal` here told operators their code was broken
              // when the daemon simply was not logged in.
              new AppError(frame.message, {
                category: frame.category ?? 'internal',
                code: 'channel-turn-failed',
              }),
            );
          }
        });
        socket.write(encode({ type: 'say', id, text }));
      });
    },
    close(): void {
      socket.destroy();
    },
  };
}

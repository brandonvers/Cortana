/**
 * The socket you talk to it through.
 *
 * ## Why a unix socket and not a port
 *
 * The M3 plan chose it, and the reasoning is worth having next to the code: a
 * socket has **no authentication to get wrong**, because the filesystem already
 * did it. The data directory M1 creates is `0700`, so a socket inside it is
 * unreachable by anyone else on the machine without any credential this project
 * has to invent, store, rotate or leak.
 *
 * The socket's own mode is set as well, and that is belt and braces rather than
 * the control: between `listen` and `chmod` there is a moment where the file
 * exists with whatever the umask allows, and the directory is what makes that
 * moment uninteresting.
 *
 * ## Why the stale socket is handled rather than reported
 *
 * A daemon killed with `SIGKILL` leaves the socket file behind, and the next
 * start fails with `EADDRINUSE` on a socket nobody is listening to. Deleting it
 * blindly would be worse — that is how two daemons end up fighting over one path
 * — so the file is *connected to* first. A refused connection means nobody is
 * home and the file is a corpse; a successful one means something is already
 * running, and that is a refusal.
 */

import { chmodSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { AppError, type Logger, PRODUCT_NAME } from '@cortana/core';
import {
  type ClientFrame,
  encode,
  MAX_FRAME_BYTES,
  parseClientFrame,
  type ServerFrame,
} from './protocol.ts';

/** Derived rather than written down, because ADR-0002 requires renaming to stay cheap. */
const SOCKET_NAME = `${PRODUCT_NAME.toLowerCase()}.sock`;

export const socketPathFor = (dataDir: string): string => join(dataDir, SOCKET_NAME);

/**
 * How long a unix socket path may be, which is shorter than anyone expects.
 *
 * The address is a fixed-size `sun_path` in a C struct, not a string: 104 bytes
 * on macOS and BSD, 108 on Linux, minus the terminator. Exceed it and `listen`
 * fails with **`EINVAL: invalid argument`** — a message that names neither the
 * path nor the length nor the limit, on a call that looks like it should have
 * worked.
 *
 * The macOS figure is measured on this project's development machine rather than
 * read from a header: 104 characters listened, 105 returned `EINVAL`. The Linux
 * figure is from `sys/un.h` and is **not** measured here; it is the larger of the
 * two, so a path this refuses on macOS would be refused there as well only if it
 * also exceeds 107.
 *
 * This is not a hypothetical. It is how the first assembled daemon failed to
 * start, on a data directory under a temporary path.
 */
export const MAX_SOCKET_PATH_BYTES = process.platform === 'darwin' ? 104 : 107;

export interface Conversation {
  /**
   * Puts a question to whoever is connected, and waits.
   *
   * Resolves `false` when they say no, when they disconnect, and when they say
   * nothing for long enough. **Never hangs**: M3's definition of done says an
   * approval you never answer must not wedge the daemon, and the safe answer to
   * an unanswered question about doing something is no.
   */
  ask(question: string, because: string): Promise<boolean>;
}

export type SayHandler = (text: string, conversation: Conversation) => Promise<string>;

export interface ChannelOptions {
  readonly dataDir: string;
  readonly onSay: SayHandler;
  readonly logger?: Logger;
  /** How long an unanswered question waits before it is treated as a no. */
  readonly askTimeoutMs?: number;
}

const DEFAULT_ASK_TIMEOUT_MS = 120_000;

export interface Channel {
  readonly path: string;
  readonly connections: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Whether something is listening on `path` right now. */
async function isLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    probe.on('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.on('error', () => {
      probe.destroy();
      resolve(false);
    });
  });
}

export function createChannel(options: ChannelOptions): Channel {
  const path = socketPathFor(options.dataDir);
  const log = options.logger?.child({ component: 'channel' });
  const askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;

  let server: Server | null = null;
  const sockets = new Set<Socket>();

  const serve = (socket: Socket): void => {
    sockets.add(socket);
    socket.setEncoding('utf8');

    /** Questions this connection is waiting on, by the id they were asked with. */
    const pending = new Map<string, (approved: boolean) => void>();
    let buffer = '';
    let asked = 0;

    const send = (frame: ServerFrame): void => {
      if (!socket.destroyed) socket.write(encode(frame));
    };

    const conversation: Conversation = {
      ask(question, because) {
        asked += 1;
        const id = `ask-${asked}`;
        return new Promise<boolean>((resolve) => {
          let settled = false;
          const settle = (approved: boolean) => {
            if (settled) return;
            settled = true;
            pending.delete(id);
            clearTimeout(timer);
            resolve(approved);
          };

          const timer = setTimeout(() => {
            log?.warn('an approval went unanswered and was treated as a refusal', {
              question,
              askTimeoutMs,
            });
            settle(false);
          }, askTimeoutMs);

          pending.set(id, settle);
          send({ type: 'ask', id, question, because });
        });
      },
    };

    const handle = async (frame: ClientFrame): Promise<void> => {
      if (frame.type === 'answer') {
        const waiting = pending.get(frame.id);
        // A stray answer is dropped rather than treated as an error: the
        // question it belonged to may have timed out a moment earlier, and
        // that race is not the person's fault.
        waiting?.(frame.approved);
        return;
      }

      try {
        send({ type: 'reply', id: frame.id, text: await options.onSay(frame.text, conversation) });
      } catch (error) {
        log?.error('a turn failed', { error: String(error) });
        send({ type: 'error', id: frame.id, message: String(error) });
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) {
        // Without this a client that never sends a newline grows the daemon's
        // memory until something else on the machine dies.
        log?.warn('a client sent an oversized frame and was disconnected', {
          bytes: buffer.length,
        });
        socket.destroy();
        return;
      }

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== '') {
          const parsed = parseClientFrame(line);
          if ('frame' in parsed) void handle(parsed.frame);
          else send({ type: 'error', id: 'unparsed', message: parsed.reason });
        }
        newline = buffer.indexOf('\n');
      }
    });

    const cleanUp = () => {
      sockets.delete(socket);
      // Anything still waiting is waiting forever otherwise, and the person who
      // would have answered has gone.
      for (const settle of pending.values()) settle(false);
      pending.clear();
    };
    socket.on('close', cleanUp);
    socket.on('error', cleanUp);
  };

  return {
    path,
    get connections() {
      return sockets.size;
    },

    async start(): Promise<void> {
      const length = Buffer.byteLength(path, 'utf8');
      if (length > MAX_SOCKET_PATH_BYTES) {
        // Checked here rather than left to `listen`, because `EINVAL` names
        // nothing and the operator's fix is one specific setting.
        throw new AppError(
          `the socket path is ${length} bytes and the operating system allows ` +
            `${MAX_SOCKET_PATH_BYTES}. Set a shorter data directory: the socket lives inside it, ` +
            `and this one is ${path}`,
          {
            category: 'config',
            code: 'channel-path-too-long',
            detail: { path, length, limit: MAX_SOCKET_PATH_BYTES },
          },
        );
      }

      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

      if (await isLive(path)) {
        throw new AppError(`something is already listening on ${path}`, {
          category: 'config',
          code: 'channel-in-use',
          detail: { path },
        });
      }
      try {
        unlinkSync(path);
        log?.debug('removed a socket left behind by an earlier run', { path });
      } catch {
        // There was nothing to remove, which is the ordinary case.
      }

      const listener = createServer(serve);
      server = listener;
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(path, () => {
          listener.off('error', reject);
          resolve();
        });
      });

      chmodSync(path, 0o600);
      log?.info('listening', { path });
    },

    async stop(): Promise<void> {
      const listener = server;
      server = null;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (!listener) return;

      await new Promise<void>((resolve) => listener.close(() => resolve()));
      try {
        unlinkSync(path);
      } catch {
        // Already gone, which is fine.
      }
    },
  };
}

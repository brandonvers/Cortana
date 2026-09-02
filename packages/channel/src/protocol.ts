/**
 * What travels over the socket.
 *
 * ## Why this is not request and response
 *
 * It nearly is. You say something, it answers. But M3's definition of done also
 * requires that a tool call the policy engine will not decide on its own is
 * **put to you** — and that happens in the middle of answering, before there is
 * anything to answer with. So the daemon has to be able to ask, and to wait.
 *
 * That makes the protocol bidirectional with correlation, which is a bigger
 * thing than a request and a response, and small enough to fit on one page.
 *
 * ## Why newline-delimited JSON
 *
 * The messages are a sentence and a verdict. A framing that needs a length
 * prefix and a parser buys nothing here, and this one can be read with `nc` when
 * something is wrong at three in the morning — which is a real property of a
 * debugging surface rather than a nicety.
 *
 * The one thing it needs is a limit, below. Without one, a client that never
 * sends a newline is a client that grows the daemon's memory until something
 * else dies.
 */

/** The most a single frame may be, before the connection is closed for it. */
export const MAX_FRAME_BYTES = 1_048_576;

/** Sent by whoever is at the keyboard. */
export type ClientFrame =
  | { readonly type: 'say'; readonly id: string; readonly text: string }
  /** An answer to an `ask`. The `id` is the question's, not a new one. */
  | { readonly type: 'answer'; readonly id: string; readonly approved: boolean };

/** Sent by the daemon. */
export type ServerFrame =
  | { readonly type: 'reply'; readonly id: string; readonly text: string }
  | {
      readonly type: 'ask';
      readonly id: string;
      readonly question: string;
      /** Why it is being asked, from the policy engine's own words. */
      readonly because: string;
    }
  | { readonly type: 'error'; readonly id: string; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Reads a line as a client frame, or explains why it is not one.
 *
 * Returns a reason rather than throwing, because the other end of this socket is
 * a person's terminal and a malformed line is far more likely to be a typo than
 * an attack. The connection survives; the line does not.
 */
export function parseClientFrame(line: string): { frame: ClientFrame } | { reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { reason: 'not valid JSON' };
  }
  if (!isRecord(value)) return { reason: 'not an object' };
  if (typeof value['id'] !== 'string' || value['id'] === '') return { reason: 'no id' };

  if (value['type'] === 'say') {
    if (typeof value['text'] !== 'string') return { reason: 'say needs text' };
    return { frame: { type: 'say', id: value['id'], text: value['text'] } };
  }
  if (value['type'] === 'answer') {
    if (typeof value['approved'] !== 'boolean') return { reason: 'answer needs approved' };
    return { frame: { type: 'answer', id: value['id'], approved: value['approved'] } };
  }
  return { reason: `unknown frame type ${JSON.stringify(value['type'])}` };
}

export function encode(frame: ServerFrame | ClientFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

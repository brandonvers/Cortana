/**
 * A reply cut into messages Telegram will accept.
 *
 * Telegram refuses a message longer than 4,096 characters with a 400, and
 * refuses an empty one the same way. A model's reply is either, sometimes, and a
 * reply that fails to send is a turn the owner paid for and never read.
 *
 * The cut prefers a paragraph break, then a line break, then a space, and only
 * then the middle of a word — so a long reply reads as several messages rather
 * than as one message broken by a machine. The limit is counted in UTF-16 code
 * units, which is what a JavaScript string measures and is never fewer than the
 * characters Telegram counts, so a piece this returns is never too long. A cut
 * that would land between the two halves of a surrogate pair moves one unit
 * left, so an emoji is never split into two invalid halves.
 */

export const TELEGRAM_MAX_MESSAGE = 4_096;

/** What is sent when the reply is empty, because an empty message is refused. */
export const EMPTY_REPLY = 'The agent finished without saying anything.';

export function splitForTelegram(text: string, limit = TELEGRAM_MAX_MESSAGE): string[] {
  if (limit < 2) throw new Error(`a message limit of ${limit} cannot hold a character`);
  if (text.trim() === '') return [EMPTY_REPLY];

  const pieces: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    // The first kind of break that falls in the second half of the window. A
    // paragraph break near the start would send a sliver and then the rest, and
    // `Math.max` over all three would never prefer a paragraph at all, since a
    // line break is always at or after the last one.
    let cut = -1;
    for (const separator of ['\n\n', '\n', ' ']) {
      const at = window.lastIndexOf(separator);
      if (at >= limit / 2) {
        cut = at;
        break;
      }
    }
    if (cut === -1) cut = limit;
    if (isLowSurrogate(rest.charCodeAt(cut))) cut -= 1;
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest !== '') pieces.push(rest);
  return pieces.filter((piece) => piece !== '');
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

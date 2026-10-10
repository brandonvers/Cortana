import { describe, expect, it } from 'vitest';
import { EMPTY_REPLY, splitForTelegram, TELEGRAM_MAX_MESSAGE } from './split.ts';

describe('a reply cut for Telegram', () => {
  it('is one message when it fits', () => {
    expect(splitForTelegram('short')).toEqual(['short']);
    const exact = 'x'.repeat(TELEGRAM_MAX_MESSAGE);
    expect(splitForTelegram(exact)).toEqual([exact]);
  });

  it('is a sentence rather than nothing when the reply is empty', () => {
    expect(splitForTelegram('')).toEqual([EMPTY_REPLY]);
    expect(splitForTelegram(' \n ')).toEqual([EMPTY_REPLY]);
  });

  it('prefers a paragraph break to a line break inside the same window', () => {
    // A line break later in the window than the paragraph break: the max of
    // the three would have chosen the line, and split the paragraph.
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(20)}\n${'c'.repeat(40)}`;
    expect(splitForTelegram(text, 100)).toEqual([
      'a'.repeat(60),
      `${'b'.repeat(20)}\n${'c'.repeat(40)}`,
    ]);
  });

  it('cuts between words before it cuts inside one', () => {
    const pieces = splitForTelegram('alpha beta gamma delta', 12);
    expect(pieces).toEqual(['alpha beta', 'gamma delta']);
  });

  it('cuts a word that has no break in it at the limit', () => {
    const pieces = splitForTelegram('x'.repeat(25), 10);
    expect(pieces).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('never splits an emoji into two halves', () => {
    // Nine single-unit characters and then a two-unit emoji: a cut at ten lands
    // between its halves.
    const text = `${'x'.repeat(9)}😀${'y'.repeat(9)}`;
    const pieces = splitForTelegram(text, 10);
    expect(pieces.join('')).toBe(text);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(10);
      // A lone half of a surrogate pair. `isWellFormed` says the same, and is
      // past this project's `lib`.
      expect(piece).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
  });

  it('loses nothing but the whitespace it cut at', () => {
    const text = Array.from({ length: 200 }, (_, i) => `sentence ${i}.`).join(' ');
    const pieces = splitForTelegram(text, 100);
    expect(pieces.join(' ')).toBe(text);
  });
});

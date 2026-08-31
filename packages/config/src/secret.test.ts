import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { REDACTED, Secret } from './secret.ts';

const VALUE = 'correct-horse-battery-staple';

describe('Secret', () => {
  it('gives the value back only through expose()', () => {
    expect(new Secret(VALUE).expose()).toBe(VALUE);
  });

  it('reports its length without revealing anything', () => {
    expect(new Secret(VALUE).length).toBe(VALUE.length);
  });

  // The point of the type. Each of these is a real way a credential has escaped
  // from a real system, so each is asserted rather than assumed from the last.
  describe('closes every route from an object to text', () => {
    const secret = new Secret(VALUE);

    it.each([
      ['String()', () => String(secret)],
      ['template literal', () => `${secret}`],
      // Concatenation is the point of this case, not a style slip: it reaches
      // Symbol.toPrimitive with the 'default' hint, which the template-literal
      // case above does not exercise.
      // biome-ignore lint/style/useTemplate: the operator under test is `+`
      ['string concatenation', () => secret + ''],
      ['toString()', () => secret.toString()],
      ['JSON.stringify, bare', () => JSON.stringify(secret)],
      ['JSON.stringify, nested', () => JSON.stringify({ credentials: { password: secret } })],
      ['util.inspect', () => inspect(secret)],
      ['util.inspect, nested and deep', () => inspect({ a: { b: { c: secret } } }, { depth: 10 })],
      ['object spread', () => JSON.stringify({ ...secret })],
      ['Object.keys', () => Object.keys(secret).join(',')],
      ['Object.entries', () => JSON.stringify(Object.entries(secret))],
      ['JSON.stringify of an array', () => JSON.stringify([secret])],
    ])('%s does not leak it', (_name, produce) => {
      expect(produce()).not.toContain(VALUE);
    });

    it('produces the redaction rather than something merely unhelpful', () => {
      expect(`${secret}`).toBe(REDACTED);
      expect(JSON.parse(JSON.stringify({ p: secret })).p).toBe(REDACTED);
      expect(inspect(secret)).toContain(REDACTED);
    });

    it('coerces to NaN rather than to a number derived from the value', () => {
      // Symbol.toPrimitive answers every hint, including 'number'. Without it,
      // a numeric credential would survive `+secret` intact.
      expect(Number(new Secret('12345'))).toBeNaN();
    });
  });

  it('does not expose the value on the instance', () => {
    const secret = new Secret(VALUE);

    expect(Object.getOwnPropertyNames(secret)).toEqual([]);
    expect(Reflect.ownKeys(secret)).toEqual([]);
  });

  it('recognises its own instances and nothing else', () => {
    expect(Secret.is(new Secret(VALUE))).toBe(true);
    expect(Secret.is(VALUE)).toBe(false);
    expect(Secret.is({ expose: () => VALUE })).toBe(false);
    expect(Secret.is(null)).toBe(false);
  });
});

import { Writable } from 'node:stream';
import { Secret } from '@cortana/config';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createLogger, REDACT_PATHS, REDACTION } from './logger.ts';

const VALUE = 'hunter2-a-real-looking-credential';

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return {
    destination,
    lines,
    text: () => lines.join(''),
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('writing', () => {
  it('writes structured entries with the message and the fields', () => {
    const sink = capture();
    createLogger({ level: 'info', destination: sink.destination }).info('storage opened', {
      path: '/var/lib/cortana/cortana.db',
    });

    const [entry] = sink.entries();
    expect(entry?.['msg']).toBe('storage opened');
    expect(entry?.['path']).toBe('/var/lib/cortana/cortana.db');
    expect(entry?.['level']).toBe(30);
  });

  it('honours the level it was given', () => {
    const sink = capture();
    const log = createLogger({ level: 'warn', destination: sink.destination });

    log.debug('not this');
    log.info('nor this');
    log.warn('this one');
    log.error('and this');

    expect(sink.entries().map((e) => e['msg'])).toEqual(['this one', 'and this']);
  });

  it('carries base fields and child fields into every entry', () => {
    const sink = capture();
    const log = createLogger({
      level: 'info',
      destination: sink.destination,
      base: { service: 'cortana' },
    });

    log.child({ component: 'storage' }).info('ready');

    const [entry] = sink.entries();
    expect(entry?.['service']).toBe('cortana');
    expect(entry?.['component']).toBe('storage');
  });
});

describe('layer one — a Secret cannot reach the output', () => {
  // The layer that actually holds. It needs no configuration, works at any
  // depth, and does not care what the field is called.
  it('redacts a Secret in a field', () => {
    const sink = capture();
    createLogger({ level: 'info', destination: sink.destination }).info('connecting', {
      // A field name deliberately not on the redaction list, so that only the
      // type can be doing the work here.
      handshake: new Secret(VALUE),
    });

    expect(sink.text()).not.toContain(VALUE);
    expect(sink.entries()[0]?.['handshake']).toBe(REDACTION);
  });

  it('redacts a Secret buried deeper than any redaction path reaches', () => {
    const sink = capture();
    createLogger({ level: 'info', destination: sink.destination }).info('deep', {
      a: { b: { c: { d: { handshake: new Secret(VALUE) } } } },
    });

    expect(sink.text()).not.toContain(VALUE);
    expect(sink.text()).toContain(REDACTION);
  });

  it('redacts a Secret in a config-shaped object', () => {
    const sink = capture();
    createLogger({ level: 'info', destination: sink.destination }).error('cannot connect', {
      config: { host: 'imap.example.invalid', credential: new Secret(VALUE) },
    });

    expect(sink.text()).not.toContain(VALUE);
  });
});

describe('layer two — field names, and how far they reach', () => {
  it('redacts a raw string under a sensitive name', () => {
    const sink = capture();
    createLogger({ level: 'info', destination: sink.destination }).info('oops', {
      password: VALUE,
    });

    expect(sink.text()).not.toContain(VALUE);
  });

  it('reaches three levels of nesting', () => {
    const sink = capture();
    const log = createLogger({ level: 'info', destination: sink.destination });

    log.info('one', { token: VALUE });
    log.info('two', { db: { token: VALUE } });
    log.info('three', { module: { db: { token: VALUE } } });

    expect(sink.text()).not.toContain(VALUE);
  });

  it('does not reach the fourth, which is why layer one exists', () => {
    // Not a defect being tolerated — a bound being recorded. fast-redact matches
    // exactly one level per `*`, so any enumeration ends somewhere. The answer
    // is to pass a Secret, not to add another star.
    const sink = capture();
    createLogger({ level: 'info', destination: sink.destination }).info('four deep', {
      a: { b: { c: { token: VALUE } } },
    });

    expect(sink.text()).toContain(VALUE);
  });

  it('leaves an ordinary field called "key" alone', () => {
    // A log that redacts ordinary values teaches people to stop reading it.
    const sink = capture();
    createLogger({ level: 'info', destination: sink.destination }).info('setting', {
      key: 'log.level',
    });

    expect(sink.entries()[0]?.['key']).toBe('log.level');
  });

  it('covers every name on the list at all three depths', () => {
    const names = new Set(REDACT_PATHS.filter((path) => !path.includes('*')));
    expect(names.size).toBeGreaterThan(10);

    for (const name of names) {
      expect(REDACT_PATHS).toContain(`*.${name}`);
      expect(REDACT_PATHS).toContain(`*.*.${name}`);
    }
  });
});

describe('the boundary, demonstrated rather than described', () => {
  it('cannot redact a credential interpolated into free text', () => {
    // Nothing in any logger can. This is asserted so the limit is a fact in the
    // test suite rather than a caveat in a comment nobody reads.
    const sink = capture();
    createLogger({ level: 'info', destination: sink.destination }).info(
      `connecting as ${new Secret(VALUE).expose()}`,
    );

    expect(sink.text()).toContain(VALUE);
  });

  it('does redact a Secret interpolated into free text, because the type closes that route', () => {
    const sink = capture();
    createLogger({ level: 'info', destination: sink.destination }).info(
      `connecting as ${new Secret(VALUE)}`,
    );

    expect(sink.text()).not.toContain(VALUE);
    expect(sink.text()).toContain(REDACTION);
  });

  it('holds that ** is accepted and does nothing, so nobody reaches for it', () => {
    // The trap this configuration exists to avoid. `**.password` looks like
    // unbounded protection, is accepted without error, and redacts nothing.
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ level: 'info', redact: { paths: ['**.password'] } }, sink);

    log.info({ a: { b: { password: VALUE } } }, 'x');

    expect(lines.join('')).toContain(VALUE);
  });
});

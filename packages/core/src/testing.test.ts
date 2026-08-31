import { describe, expect, it } from 'vitest';
import { manualClock, recordingLogger } from './testing.ts';

describe('recordingLogger', () => {
  // A broken test double silently weakens every test that uses it, which is
  // the argument for testing one at all.
  it('keeps the level, the message, and the fields', () => {
    const log = recordingLogger();
    log.info('opened', { path: '/tmp/x' });
    log.error('failed', { code: 'nope' });

    expect(log.entries).toEqual([
      { level: 'info', message: 'opened', fields: { path: '/tmp/x' } },
      { level: 'error', message: 'failed', fields: { code: 'nope' } },
    ]);
  });

  it('merges child fields under the child’s own', () => {
    const log = recordingLogger({ service: 'cortana' });
    log.child({ component: 'storage' }).warn('slow', { ms: 12 });

    expect(log.entries[0]?.fields).toEqual({ service: 'cortana', component: 'storage', ms: 12 });
  });

  it('records everything a child writes on the parent', () => {
    const log = recordingLogger();
    log.child({ a: 1 }).child({ b: 2 }).debug('nested');

    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.fields).toEqual({ a: 1, b: 2 });
  });

  it('redacts nothing of its own', () => {
    // Deliberate: a double that hid a leak would hide it from the test written
    // to catch it.
    const log = recordingLogger();
    log.info('careless', { password: 'plain-text' });

    expect(log.text()).toContain('plain-text');
  });
});

describe('manualClock and recordingLogger together', () => {
  it('are independent doubles with no shared state', () => {
    const clock = manualClock();
    const log = recordingLogger();
    clock.advance(5);
    log.info('tick', { at: clock.now() });

    expect(log.entries[0]?.fields['at']).toBe(clock.now());
  });
});

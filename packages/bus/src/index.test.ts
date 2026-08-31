import { isAppError } from '@cortana/core';
import { describe, expect, it, vi } from 'vitest';
import { type Bus, createBus, type HandlerFailure } from './index.ts';

interface TestEvents {
  'instance.started': { id: string; startedAt: number };
  'config.reloaded': { file: string | null };
  'nothing.attached': void;
}

function bus(): { bus: Bus<TestEvents>; failures: HandlerFailure[] } {
  const failures: HandlerFailure[] = [];
  return { bus: createBus<TestEvents>({ onHandlerError: (f) => failures.push(f) }), failures };
}

describe('the compile-time contract', () => {
  // ADR-0011's actual promise. These are assertions the typechecker makes: an
  // unused @ts-expect-error is itself an error, so if the bus ever stops
  // distinguishing event names or payloads, the build fails rather than a
  // subscriber quietly never firing in production.
  it('will not publish an event nobody declared', () => {
    const { bus: b } = bus();

    // @ts-expect-error there is no such event in TestEvents
    const attempt = () => b.publish('instance.stared', { id: 'x', startedAt: 1 });

    expect(typeof attempt).toBe('function');
    b.close();
  });

  it('will not publish the wrong payload for a real event', () => {
    const { bus: b } = bus();

    // @ts-expect-error startedAt is a number, and id is required
    const attempt = () => b.publish('instance.started', { startedAt: '1' });

    expect(typeof attempt).toBe('function');
    b.close();
  });

  it('gives the subscriber the payload type without being told', () => {
    const { bus: b } = bus();
    let seen = 0;

    b.subscribe('instance.started', (payload) => {
      // No annotation and no cast: payload.startedAt is a number here because
      // the map says so. That inference is the contract.
      seen = payload.startedAt + 1;
    });

    void b.publish('instance.started', { id: 'a', startedAt: 41 });
    expect(seen).toBe(42);
    b.close();
  });
});

describe('delivery', () => {
  it('reaches every subscriber to that event and no others', async () => {
    const { bus: b } = bus();
    const started = vi.fn();
    const reloaded = vi.fn();

    b.subscribe('instance.started', started);
    b.subscribe('config.reloaded', reloaded);
    await b.publish('instance.started', { id: 'a', startedAt: 1 });

    expect(started).toHaveBeenCalledWith({ id: 'a', startedAt: 1 });
    expect(reloaded).not.toHaveBeenCalled();
  });

  it('invokes handlers in the order they subscribed', async () => {
    const { bus: b } = bus();
    const order: number[] = [];
    for (let i = 0; i < 5; i++) {
      b.subscribe('config.reloaded', () => {
        order.push(i);
      });
    }

    await b.publish('config.reloaded', { file: null });

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it('waits for asynchronous handlers before settling', async () => {
    const { bus: b } = bus();
    let finished = false;
    b.subscribe('config.reloaded', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });

    await b.publish('config.reloaded', { file: null });

    expect(finished).toBe(true);
  });

  it('does not make one handler wait for another', async () => {
    // Subscribers are independent by design. If they were awaited in sequence,
    // the slowest would decide how fast the rest see the world.
    const { bus: b } = bus();
    const startedAt: number[] = [];
    const slow = async () => {
      startedAt.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    b.subscribe('config.reloaded', slow);
    b.subscribe('config.reloaded', slow);

    await b.publish('config.reloaded', { file: null });

    expect(startedAt).toHaveLength(2);
    expect((startedAt[1] ?? 0) - (startedAt[0] ?? 0)).toBeLessThan(15);
  });

  it('is quiet when nobody is listening', async () => {
    const { bus: b } = bus();

    await expect(b.publish('nothing.attached', undefined)).resolves.toBeUndefined();
    expect(b.stats.published).toBe(1);
    expect(b.stats.delivered).toBe(0);
  });
});

describe('a subscriber failing is that subscriber’s problem', () => {
  it('does not reject the publisher when a handler throws', async () => {
    const { bus: b, failures } = bus();
    b.subscribe('config.reloaded', () => {
      throw new Error('my bug');
    });
    const after = vi.fn();
    b.subscribe('config.reloaded', after);

    await expect(b.publish('config.reloaded', { file: null })).resolves.toBeUndefined();

    // The one after it still ran: a publisher is not responsible for code it
    // does not know about, and neither is the next subscriber.
    expect(after).toHaveBeenCalledOnce();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.event).toBe('config.reloaded');
    expect(failures[0]?.position).toBe(0);
  });

  it('reports an asynchronous rejection the same way', async () => {
    const { bus: b, failures } = bus();
    b.subscribe('config.reloaded', async () => {
      throw new Error('later');
    });

    await expect(b.publish('config.reloaded', { file: null })).resolves.toBeUndefined();

    expect(failures).toHaveLength(1);
    expect((failures[0]?.error as Error | undefined)?.message).toBe('later');
  });

  it('counts a failed handler as failed and not also as delivered', async () => {
    const { bus: b } = bus();
    b.subscribe('config.reloaded', () => {
      // a handler that simply succeeds
    });
    b.subscribe('config.reloaded', async () => {
      throw new Error('no');
    });

    await b.publish('config.reloaded', { file: null });

    expect(b.stats.delivered).toBe(1);
    expect(b.stats.failed).toBe(1);
  });
});

describe('unsubscribing', () => {
  it('stops delivery', async () => {
    const { bus: b } = bus();
    const handler = vi.fn();
    const off = b.subscribe('config.reloaded', handler);

    await b.publish('config.reloaded', { file: null });
    off();
    await b.publish('config.reloaded', { file: null });

    expect(handler).toHaveBeenCalledOnce();
  });

  it('is harmless to call twice', () => {
    const { bus: b } = bus();
    const off = b.subscribe('config.reloaded', vi.fn());

    off();
    expect(off).not.toThrow();
    expect(b.stats.subscribers).toBe(0);
  });

  it('takes effect even mid-delivery', async () => {
    // "Off means off" (CONCEPTS §5.2) should not have an exception for timing.
    const { bus: b } = bus();
    const later = vi.fn();
    let off: () => void = () => undefined;
    b.subscribe('config.reloaded', () => off());
    off = b.subscribe('config.reloaded', later);

    await b.publish('config.reloaded', { file: null });

    expect(later).not.toHaveBeenCalled();
  });

  it('does not deliver to a handler that subscribed during the same publish', async () => {
    // Otherwise a handler that subscribes in reaction to an event receives that
    // same event, which is a loop that is very hard to see in a stack trace.
    const { bus: b } = bus();
    const late = vi.fn();
    b.subscribe('config.reloaded', () => {
      b.subscribe('config.reloaded', late);
    });

    await b.publish('config.reloaded', { file: null });

    expect(late).not.toHaveBeenCalled();
    await b.publish('config.reloaded', { file: null });
    expect(late).toHaveBeenCalledOnce();
  });
});

describe('closing', () => {
  it('throws at the call site rather than rejecting a promise nobody awaits', () => {
    // A fire-and-forget publisher never looks at the returned promise, so a
    // rejection would surface as an unhandled rejection during shutdown — the
    // moment with the least attention to spare.
    const { bus: b } = bus();
    b.close();

    expect(() => b.publish('config.reloaded', { file: null })).toThrow(/closed/);
    try {
      b.publish('config.reloaded', { file: null });
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('bus-closed');
    }
  });

  it('refuses new subscriptions', () => {
    const { bus: b } = bus();
    b.close();

    expect(() => b.subscribe('config.reloaded', vi.fn())).toThrow(/closed/);
  });

  it('forgets everyone', async () => {
    const { bus: b } = bus();
    b.subscribe('config.reloaded', vi.fn());
    expect(b.stats.subscribers).toBe(1);

    b.close();

    expect(b.stats.subscribers).toBe(0);
    expect(b.closed).toBe(true);
  });
});

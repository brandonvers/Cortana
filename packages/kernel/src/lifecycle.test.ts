import { isAppError } from '@cortana/core';
import { recordingLogger } from '@cortana/core/testing';
import { describe, expect, it } from 'vitest';
import { type Component, createLifecycle, type Health } from './lifecycle.ts';

function tracker() {
  const events: string[] = [];
  const component = (
    name: string,
    behaviour: {
      failStart?: boolean;
      failStop?: boolean;
      hangStop?: boolean;
      health?: Health;
    } = {},
  ): Component => ({
    name,
    start() {
      if (behaviour.failStart) throw new Error(`${name} refuses to start`);
      events.push(`start:${name}`);
    },
    async stop() {
      if (behaviour.failStop) throw new Error(`${name} refuses to stop`);
      if (behaviour.hangStop) await new Promise(() => undefined);
      events.push(`stop:${name}`);
    },
    ...(behaviour.health ? { health: () => behaviour.health as Health } : {}),
  });
  return { events, component };
}

const logger = () => recordingLogger();

describe('starting', () => {
  it('starts components in the order it was given them', async () => {
    const { events, component } = tracker();
    const life = createLifecycle({
      components: [component('a'), component('b'), component('c')],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    await life.start();

    expect(events).toEqual(['start:a', 'start:b', 'start:c']);
    expect(life.state).toBe('running');
  });

  it('stops what already started when one fails, in reverse', async () => {
    // The failure this exists to prevent: a start that throws halfway leaves a
    // database open and a queue accepting work with nobody supervising either.
    const { events, component } = tracker();
    const life = createLifecycle({
      components: [component('a'), component('b'), component('c', { failStart: true })],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    await expect(life.start()).rejects.toThrow(/failed to start/);

    expect(events).toEqual(['start:a', 'start:b', 'stop:b', 'stop:a']);
    expect(life.state).toBe('failed');
  });

  it('names the component that failed and keeps the original error', async () => {
    const { component } = tracker();
    const life = createLifecycle({
      components: [component('storage', { failStart: true })],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    try {
      await life.start();
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('component-start-failed');
      expect(isAppError(error) && error.detail['component']).toBe('storage');
      expect((error as Error).cause).toBeInstanceOf(Error);
    }
  });

  it('keeps rolling back even when the rollback itself fails', async () => {
    // A rollback failure must not replace the start failure, which is the one
    // worth raising.
    const { events, component } = tracker();
    const life = createLifecycle({
      components: [
        component('a'),
        component('b', { failStop: true }),
        component('c', { failStart: true }),
      ],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    await expect(life.start()).rejects.toThrow(/"c" failed to start/);

    expect(events).toEqual(['start:a', 'start:b', 'stop:a']);
  });

  it('refuses to start twice', async () => {
    const { component } = tracker();
    const life = createLifecycle({
      components: [component('a')],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    await life.start();
    await expect(life.start()).rejects.toThrow(/cannot start from the "running" state/);
  });
});

describe('stopping', () => {
  it('stops in the reverse of the start order', async () => {
    const { events, component } = tracker();
    const life = createLifecycle({
      components: [component('a'), component('b'), component('c')],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    await life.start();
    const report = await life.stop('test');

    expect(events).toEqual(['start:a', 'start:b', 'start:c', 'stop:c', 'stop:b', 'stop:a']);
    expect(report.clean).toBe(true);
    expect(report.components.map((c) => c.name)).toEqual(['c', 'b', 'a']);
  });

  it('keeps going when one component fails to stop', async () => {
    const { events, component } = tracker();
    const life = createLifecycle({
      components: [component('a'), component('b', { failStop: true }), component('c')],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    await life.start();
    const report = await life.stop('test');

    expect(events).toContain('stop:a');
    expect(report.clean).toBe(false);
    expect(report.components.find((c) => c.name === 'b')?.outcome).toBe('failed');
    expect(report.components.find((c) => c.name === 'a')?.outcome).toBe('stopped');
  });

  it('runs the sequence once however many times it is asked', async () => {
    // Shutdown is reached from a signal handler, and two signals arriving close
    // together must not run the sequence twice.
    const { events, component } = tracker();
    const life = createLifecycle({
      components: [component('a')],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    await life.start();
    const [first, second] = await Promise.all([life.stop('one'), life.stop('two')]);

    expect(events.filter((e) => e === 'stop:a')).toHaveLength(1);
    expect(first).toBe(second);
    expect(first?.reason).toBe('one');
  });
});

describe('the deadline bounds the wait, not the work', () => {
  it('reports a component that will not finish, and does not touch the rest', async () => {
    // JavaScript cannot interrupt a stop() that never returns. Closing the
    // components underneath it would be worse than leaving them: ADR-0017 makes
    // every acknowledged write durable already, so an unclean stop costs a WAL
    // replay and nothing else.
    const { events, component } = tracker();
    const life = createLifecycle({
      components: [component('a'), component('b'), component('c', { hangStop: true })],
      logger: logger(),
      stopTimeoutMs: 30,
    });

    await life.start();
    const report = await life.stop('deadline');

    expect(report.clean).toBe(false);
    expect(report.components.find((c) => c.name === 'c')?.outcome).toBe('timed-out');
    expect(report.components.find((c) => c.name === 'b')?.outcome).toBe('not-reached');
    expect(report.components.find((c) => c.name === 'a')?.outcome).toBe('not-reached');
    expect(events).not.toContain('stop:a');
  });

  it('finishes well inside a generous deadline', async () => {
    const { component } = tracker();
    const life = createLifecycle({
      components: [component('a'), component('b')],
      logger: logger(),
      stopTimeoutMs: 5_000,
    });

    await life.start();
    const report = await life.stop('quick');

    expect(report.clean).toBe(true);
    expect(report.ms).toBeLessThan(1_000);
  });
});

describe('health', () => {
  it('takes the worst status any component reports', async () => {
    const { component } = tracker();
    const life = createLifecycle({
      components: [
        component('a', { health: { status: 'ok' } }),
        component('b', { health: { status: 'degraded', detail: 'busy' } }),
        component('c', { health: { status: 'ok' } }),
      ],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    await life.start();

    expect((await life.health()).status).toBe('degraded');
  });

  it('treats a component with no health check as healthy, and says so', async () => {
    const { component } = tracker();
    const life = createLifecycle({
      components: [component('a')],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    await life.start();
    const report = await life.health();

    expect(report.status).toBe('ok');
    expect(report.components[0]?.health.detail).toMatch(/no health/);
  });

  it('counts a health check that throws as failing rather than losing the report', async () => {
    const life = createLifecycle({
      components: [
        {
          name: 'broken',
          start: () => undefined,
          stop: () => undefined,
          health: () => {
            throw new Error('cannot tell');
          },
        },
      ],
      logger: logger(),
      stopTimeoutMs: 1_000,
    });

    await life.start();
    const report = await life.health();

    expect(report.status).toBe('failing');
    expect(report.components[0]?.health.detail).toContain('cannot tell');
  });
});

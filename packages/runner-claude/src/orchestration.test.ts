import { isAppError } from '@cortana/core';
import { describe, expect, it } from 'vitest';
import { createClaudeRunner, type ProviderQuery } from './adapter.ts';

/**
 * The half of the adapter that is not translation.
 *
 * A deadline, a stream that ends without answering, a warning pushed mid-turn:
 * none of it is checkable against the real provider on demand, and all of it is
 * what stands between an unresponsive session and a kernel that waits for the
 * life of the process. So a stand-in opens the conversation.
 */
function conversation(messages: AsyncIterable<Record<string, unknown>>): ProviderQuery {
  let interrupted = false;
  return Object.assign(messages, {
    close: () => undefined,
    interrupt: () => {
      interrupted = true;
      return interrupted;
    },
  }) as ProviderQuery;
}

/** A conversation that never says anything, and never ends. */
const silent = (): ProviderQuery =>
  conversation({
    async *[Symbol.asyncIterator]() {
      await new Promise(() => undefined);
    },
  });

const answers = (...items: Record<string, unknown>[]): ProviderQuery =>
  conversation({
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  });

const success = (text: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: text,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe('a session that stops answering', () => {
  it('gives up on its own rather than waiting for the life of the process', async () => {
    const runner = await createClaudeRunner({ openConversation: silent, turnTimeoutMs: 40 });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a' });

    const failure = await session.turn('anything').catch((error: unknown) => error);

    expect(isAppError(failure) && failure.code).toBe('turn-timed-out');
    expect(isAppError(failure) && failure.category).toBe('timeout');
  });

  it('is over once it has timed out, rather than left half-alive', async () => {
    // A session that has been given up on must not look usable, or the next
    // caller waits the same deadline again for the same reason.
    const runner = await createClaudeRunner({ openConversation: silent, turnTimeoutMs: 40 });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a' });

    await session.turn('anything').catch(() => undefined);

    expect(session.stopped).toBe(true);
    await expect(session.turn('again')).rejects.toThrow(/stopped/);
  });

  it('says how long it waited, so the deadline is arguable', async () => {
    const runner = await createClaudeRunner({ openConversation: silent, turnTimeoutMs: 40 });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a' });

    const failure = await session.turn('anything').catch((error: unknown) => error);

    expect((failure as Error).message).toContain('40 ms');
    expect(isAppError(failure) && failure.detail['timeoutMs']).toBe(40);
  });
});

describe('a turn that answers in time', () => {
  it('is not cut short by the deadline', async () => {
    const runner = await createClaudeRunner({
      openConversation: () => answers(success('here you are')),
      turnTimeoutMs: 5_000,
    });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a' });

    expect((await session.turn('anything')).text).toBe('here you are');
  });

  it('leaves nothing behind that keeps the process awake', async () => {
    // The timer is deliberately not unref'd — a turn in flight is a reason to
    // stay alive — so it has to be cleared, or a finished turn would hold the
    // event loop open for the length of its deadline.
    const runner = await createClaudeRunner({
      openConversation: () => answers(success('done')),
      turnTimeoutMs: 60_000,
    });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a' });

    await session.turn('anything');
    await session.stop();

    // If a timer were still pending, this test file would hold vitest open for
    // a minute rather than finishing.
    expect(session.stopped).toBe(true);
  });
});

describe('a stream that ends without answering', () => {
  it('is reported rather than hung on', async () => {
    const runner = await createClaudeRunner({ openConversation: () => answers() });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a' });

    const failure = await session.turn('anything').catch((error: unknown) => error);

    expect(isAppError(failure) && failure.code).toBe('session-ended-early');
  });
});

describe('a warning pushed mid-turn', () => {
  it('reaches the observer and does not disturb the answer', async () => {
    const seen: string[] = [];
    const runner = await createClaudeRunner({
      openConversation: () =>
        answers(
          {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'allowed_warning',
              rateLimitType: 'seven_day',
              utilization: 0.87,
            },
          },
          success('answered anyway'),
        ),
      onRateLimit: (warning) => seen.push(`${warning.window}:${warning.utilization}`),
    });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a' });

    const result = await session.turn('anything');

    expect(seen).toEqual(['seven_day:0.87']);
    expect(result.text).toBe('answered anyway');
  });
});

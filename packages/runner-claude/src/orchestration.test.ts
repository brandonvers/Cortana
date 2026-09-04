import { isAppError } from '@cortana/core';
import { recordingLogger } from '@cortana/core/testing';
import { type Profile, QUARANTINE } from '@cortana/policy';
import { TEST_PROFILE } from '@cortana/runner/testing';
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
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

    const failure = await session.turn('anything').catch((error: unknown) => error);

    expect(isAppError(failure) && failure.code).toBe('turn-timed-out');
    expect(isAppError(failure) && failure.category).toBe('timeout');
  });

  it('is over once it has timed out, rather than left half-alive', async () => {
    // A session that has been given up on must not look usable, or the next
    // caller waits the same deadline again for the same reason.
    const runner = await createClaudeRunner({ openConversation: silent, turnTimeoutMs: 40 });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

    await session.turn('anything').catch(() => undefined);

    expect(session.stopped).toBe(true);
    await expect(session.turn('again')).rejects.toThrow(/stopped/);
  });

  it('says how long it waited, so the deadline is arguable', async () => {
    const runner = await createClaudeRunner({ openConversation: silent, turnTimeoutMs: 40 });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

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
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

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
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

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
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

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
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });

    const result = await session.turn('anything');

    expect(seen).toEqual(['seven_day:0.87']);
    expect(result.text).toBe('answered anyway');
  });
});

describe('what the log is told about rate limits', () => {
  const runWith = async (status: string) => {
    const logger = recordingLogger();
    const runner = await createClaudeRunner({
      logger,
      openConversation: () =>
        answers(
          { type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour' } },
          success('fine'),
        ),
    });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile: TEST_PROFILE });
    await session.turn('anything');
    return logger;
  };

  it('does not warn about headroom', async () => {
    // A log that calls every ordinary state a warning is a log people stop
    // reading, and the provider pushes these at `allowed` routinely.
    const logger = await runWith('allowed');

    expect(logger.entries.map((e) => e.level)).not.toContain('warn');
    expect(logger.entries.some((e) => e.level === 'debug')).toBe(true);
  });

  it('warns about the states that mean something', async () => {
    const logger = await runWith('allowed_warning');

    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true);
    expect(logger.text()).toContain('limiting this account');
  });

  it('leaves a missing utilization out rather than reporting a sentinel', async () => {
    // The first live event carried none. A -1 in the field would be read as a
    // number by whatever aggregates these later.
    const logger = await runWith('allowed_warning');

    expect(logger.text()).not.toContain('-1');
    expect(logger.entries.at(-1)?.fields).not.toHaveProperty('utilization');
  });
});

describe('the profile, on its way to the provider', () => {
  /**
   * What `query` was actually called with.
   *
   * The assertions below deliberately read the call rather than `settingsFor`.
   * `settingsFor` was correct and fully tested from the moment it was written,
   * and until this milestone it was called by nothing: every containment finding
   * five spikes produced was computed and dropped. Testing the renderer proves
   * the renderer; only the call proves the session.
   */
  async function optionsFor(profile: Profile): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | null = null;
    const runner = await createClaudeRunner({
      openConversation: (params) => {
        captured = (params as { options: Record<string, unknown> }).options;
        return answers(success('ok'));
      },
    });
    const session = await runner.start({ tier: 'fast', systemPrompt: 'a', profile });
    await session.stop();
    if (captured === null) throw new Error('the conversation was never opened');
    return captured;
  }

  it('hands the provider the profile as the list of tools that exist', async () => {
    // The measurement that put this here: on 2026-09-02 a session under
    // QUARANTINE called `ToolSearch` successfully and listed eighteen reachable
    // tools, none of them in `KNOWN_TOOLS`. Withholding by name can only reach
    // names this repository knows. This option is the allowlist, and the
    // provider's own docs point at it from `allowedTools`.
    expect((await optionsFor(QUARANTINE))['tools']).toEqual([]);
    expect((await optionsFor({ ...QUARANTINE, tools: ['Read'] }))['tools']).toEqual(['Read']);
  });

  it('decides every tool call on both surfaces the provider offers', async () => {
    const options = await optionsFor(QUARANTINE);

    // `canUseTool` alone was measured never firing for `Read` — it is the *ask*
    // surface, and a call the provider resolves on its own never reaches it. The
    // hook fires where it does not, and both run the same decision.
    expect(options['canUseTool']).toBeTypeOf('function');
    const hooks = options['hooks'] as { PreToolUse: { hooks: unknown[] }[] };
    expect(hooks.PreToolUse[0]?.hooks[0]).toBeTypeOf('function');
  });

  it('refuses a call through the hook, in the shape the provider reads', async () => {
    const options = await optionsFor(QUARANTINE);
    const hook = (
      options['hooks'] as { PreToolUse: { hooks: ((i: unknown) => Promise<unknown>)[] }[] }
    ).PreToolUse[0]?.hooks[0];

    const outcome = (await hook?.({
      tool_name: 'ToolSearch',
      tool_input: { query: 'select:Read' },
    })) as { hookSpecificOutput: { permissionDecision: string } };

    expect(outcome.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('removes every tool the profile does not name', async () => {
    const options = await optionsFor(QUARANTINE);
    const deny = (options['settings'] as { permissions: { deny: string[] } }).permissions.deny;

    // A bare tool name removes the tool rather than gating it — spike 0011, and
    // the strongest lock the provider offers.
    expect(deny).toContain('Bash');
    expect(deny).toContain('Read');
    expect(deny).toContain('WebFetch');
  });

  it('carries the deny rules through the flag layer, not the managed one', async () => {
    const options = await optionsFor({
      name: 'reader',
      trust: 'system',
      tools: ['Read'],
      readable: ['/srv/work'],
      writable: [],
      denyRead: ['/srv/work/secrets'],
      network: 'denied',
      sandbox: 'required',
      confirm: 'never',
    });

    // Spike 0010 measured the SDK's managed tier being dropped entirely on a
    // machine that has an admin-controlled managed-settings tier — which would
    // remove these rules on exactly the machines most likely to have one.
    expect(options).not.toHaveProperty('managedSettings');
    const deny = (options['settings'] as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain('Read(//srv/work/secrets/**)');
    expect(deny).not.toContain('Read');
  });

  it('requires the sandbox through the channel that carries the requirement', async () => {
    const options = await optionsFor(QUARANTINE);

    expect(options['sandbox']).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
    });
  });

  it('says an optional sandbox is optional, rather than leaving it to a default', async () => {
    const options = await optionsFor({ ...QUARANTINE, sandbox: 'optional' });

    // The default for this flag depends on the channel that delivers it — spike
    // 0010 — so an omitted value through this one means `required`. A profile
    // that says optional and refuses to start on a host without bubblewrap is a
    // failure with no explanation anywhere in the profile.
    expect(options['sandbox']).toMatchObject({ enabled: true, failIfUnavailable: false });
  });

  it('leaves the session nothing but the profile to be shaped by', async () => {
    const options = await optionsFor(QUARANTINE);

    expect(options['settingSources']).toEqual([]);
    expect(options['strictMcpConfig']).toBe(true);
    expect(options['mcpServers']).toEqual({});
  });
});

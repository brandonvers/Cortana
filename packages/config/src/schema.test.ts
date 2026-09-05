import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { configSchema, secretSchema } from './schema.ts';
import { Secret } from './secret.ts';

const VALID = {
  dataDir: '/var/lib/cortana',
  log: { level: 'info' },
  audit: { retentionDays: 90 },
  agent: {
    persona: 'You are Cortana.',
    tier: 'balanced',
    tools: [],
    readable: [],
    writable: [],
    confirm: 'writes',
  },
  shutdown: { timeoutMs: 15_000 },
};

describe('configSchema', () => {
  it('accepts a complete configuration', () => {
    expect(configSchema.parse(VALID)).toEqual(VALID);
  });

  it('rejects an unrecognised key instead of ignoring it', () => {
    // The failure this prevents: a misspelled setting that silently does
    // nothing, on a system that starts and looks configured.
    const result = configSchema.safeParse({ ...VALID, logLevl: 'debug' });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('logLevl');
  });

  it('rejects an unrecognised key inside a nested table too', () => {
    const result = configSchema.safeParse({ ...VALID, log: { level: 'info', colour: true } });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('colour');
  });

  it('insists the data directory is absolute', () => {
    const result = configSchema.safeParse({ ...VALID, dataDir: 'state' });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('absolute');
  });

  it('accepts every level it advertises and no others', () => {
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
      expect(configSchema.safeParse({ ...VALID, log: { level } }).success).toBe(true);
    }
    expect(configSchema.safeParse({ ...VALID, log: { level: 'verbose' } }).success).toBe(false);
  });

  it('bounds the shutdown deadline at both ends', () => {
    const withTimeout = (timeoutMs: unknown) =>
      configSchema.safeParse({ ...VALID, shutdown: { timeoutMs } }).success;

    expect(withTimeout(1)).toBe(true);
    expect(withTimeout(600_000)).toBe(true);
    expect(withTimeout(0)).toBe(false);
    expect(withTimeout(-1)).toBe(false);
    expect(withTimeout(600_001)).toBe(false);
    expect(withTimeout(1.5)).toBe(false);
    expect(withTimeout('15000')).toBe(false);
  });
});

describe('secretSchema', () => {
  it('produces a Secret rather than a string', () => {
    const parsed = secretSchema.parse('hunter2');

    expect(Secret.is(parsed)).toBe(true);
    expect(parsed.expose()).toBe('hunter2');
  });

  it('rejects an empty value', () => {
    expect(secretSchema.safeParse('').success).toBe(false);
  });

  it('never puts the value in its error output', () => {
    // The property that has to hold before the first real credential exists,
    // because by then it is too late to find out otherwise.
    //
    // It is tested on a *narrowed* secret rather than on `secretSchema` itself,
    // because the base schema's only failing input is the empty string, which
    // has nothing to leak. A module requiring a key of some minimum length is
    // the realistic shape, and it is the shape that gives a validator a reason
    // to describe the value it rejected.
    const apiKey = z
      .string()
      .min(32)
      .transform((value) => new Secret(value));
    const rejected = 'sk-live-too-short';

    const result = apiKey.safeParse(rejected);

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(rejected);
    expect(JSON.stringify(result.error?.issues)).not.toContain('sk-live');
  });

  it('does not echo a value of the wrong type either', () => {
    const result = secretSchema.safeParse({ password: 'hunter2' });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('hunter2');
  });
});

describe('audit retention', () => {
  const withRetention = (retentionDays: unknown) =>
    configSchema.safeParse({ ...VALID, audit: { retentionDays } }).success;

  it('accepts zero, which ADR-0019 defines as keeping everything', () => {
    // Zero has to be written down to take effect, which is the whole point of
    // making it representable rather than treating an unset value as infinite.
    expect(withRetention(0)).toBe(true);
  });

  it('accepts a working window', () => {
    expect(withRetention(90)).toBe(true);
    expect(withRetention(3_650)).toBe(true);
  });

  it('refuses a negative window and a decade-plus one', () => {
    // A value past ten years is far likelier to be a typo than an intention,
    // and this is a record of what an operator said to their own machine.
    expect(withRetention(-1)).toBe(false);
    expect(withRetention(3_651)).toBe(false);
    expect(withRetention(1.5)).toBe(false);
  });
});

describe('the agent section', () => {
  const agent = (over: Record<string, unknown>) =>
    configSchema.safeParse({ ...VALID, agent: { ...VALID.agent, ...over } });

  it('insists a persona says something', () => {
    expect(agent({ persona: '' }).success).toBe(false);
  });

  it('accepts only tiers the port has', () => {
    expect(agent({ tier: 'fast' }).success).toBe(true);
    expect(agent({ tier: 'enormous' }).success).toBe(false);
  });

  it('refuses a relative path, which resolves against a directory nobody meant', () => {
    // For a service the working directory is `/`. A relative path here is a
    // permission granted somewhere other than where it was written.
    expect(agent({ readable: ['/srv/work'] }).success).toBe(true);
    expect(agent({ readable: ['work'] }).success).toBe(false);
    expect(agent({ writable: ['relative/too'] }).success).toBe(false);
  });

  it('has no way to say "grant tools and skip the sandbox"', () => {
    // There is no sandbox setting here at all, and that is the design:
    // `workingProfile` derives it from the tools, so the two cannot drift.
    expect(agent({ sandbox: 'none' }).success).toBe(false);
  });
});

/**
 * What a valid configuration looks like, and nothing more.
 *
 * Two rules govern what appears here.
 *
 * **A setting exists because something reads it.** M1 has three. Settings for
 * milestones that have not been built would be guesses that later have to be
 * either honoured or broken.
 *
 * **Not everything configurable should be configured.** ADR-0017 makes SQLite's
 * `synchronous` setting deliberately absent: a durability guarantee that a
 * configuration file can switch off is not a guarantee, and the failure it
 * produces — a lost transaction after a power cut, months later — is untraceable
 * to the setting that caused it.
 */

import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { Secret } from './secret.ts';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Repeated here rather than imported from `@cortana/runner`.
 *
 * This package is what every other one reads its settings through, and it holds
 * no dependency on anything that could pull a provider in behind it. Three
 * strings are cheaper than that edge, and a test in `@cortana/kernel` — which
 * already depends on both — fails if the two lists ever disagree.
 */
export const MODEL_TIERS = ['fast', 'balanced', 'deep'] as const;

/**
 * The object is strict: an unrecognised key is an error rather than something
 * ignored. A misspelled setting that silently does nothing is the worst outcome
 * available, because the system starts, looks configured, and behaves as though
 * the line had never been written.
 */
export const configSchema = z.strictObject({
  /**
   * Where the database and everything else durable lives. Must be absolute — a
   * relative path resolves against the working directory, which for a service is
   * `/` and is not what anybody means.
   */
  dataDir: z.string().min(1).refine(isAbsolute, { error: 'must be an absolute path' }),

  log: z.strictObject({
    level: z.enum(LOG_LEVELS),
  }),

  audit: z.strictObject({
    /**
     * How long a turn's record is kept.
     *
     * [ADR-0019](../../../docs/adr/0019-the-audit-stores-what-was-said.md) makes
     * this a number rather than "forever", because unbounded retention is not a
     * decision to keep everything — it is a decision to defer deletion to the day
     * the disk fills, when it will be made in a hurry.
     *
     * Zero keeps everything, and has to be written down to take effect. The
     * upper bound is ten years: a value past it is far likelier to be a typo
     * than an intention, and this is a record of what an operator said to their
     * own machine.
     */
    retentionDays: z.int().min(0).max(3_650),
  }),

  agent: z.strictObject({
    /**
     * Who the one agent is. Its competence and its character, in its own words.
     *
     * The only half of a system prompt a person writes: what it may do is
     * composed from the profile below, and neither half is a security control.
     */
    persona: z.string().min(1),
    tier: z.enum(MODEL_TIERS),
    /**
     * What it may reach for. **Empty by default, and that is the safe default
     * rather than a placeholder.**
     *
     * M3 has one agent that talks and remembers nothing, so a tool granted here
     * is a capability nobody has asked for yet. Granting one also turns the
     * sandbox on — `workingProfile` derives that rather than taking it, so the
     * two cannot drift apart.
     *
     * When the roster arrives in M4 this moves into an agent definition, where
     * it belongs. It is here now because the alternative is an assembled daemon
     * whose approval path cannot be reached.
     */
    tools: z.array(z.string().min(1)),
    readable: z.array(z.string().refine(isAbsolute, { error: 'must be an absolute path' })),
    writable: z.array(z.string().refine(isAbsolute, { error: 'must be an absolute path' })),
    /**
     * Which permitted calls are still put to whoever is connected.
     *
     * `writes` treats modification and egress as one question, because from an
     * operator's side they are one question: is this irreversible?
     */
    confirm: z.enum(['never', 'writes', 'always']),
  }),

  roster: z.strictObject({
    /**
     * Where agent definitions live. Absolute, and an absent directory is an
     * empty roster rather than an error — a first run has no agents yet.
     */
    directory: z.string().min(1).refine(isAbsolute, { error: 'must be an absolute path' }),
    /**
     * How long an agent stays awake with nothing to do.
     *
     * [ADR-0006](../../../docs/adr/0006-dormancy-is-the-default.md) makes
     * dormancy the default and [spike 0003](../../../docs/spikes/0003-concurrent-sessions.md)
     * measured what it costs: **−195 ms** on the realistic profile, and at worst
     * a few hundred milliseconds added to a multi-second reply. So this can be
     * short without hurting, and a long one costs 264 MB and a live context per
     * agent for nothing.
     *
     * Zero is not allowed. An agent that sleeps the instant it finishes would
     * pay a cold start for every turn of one conversation, which is the 5.4–6.2 s
     * dormancy exists to avoid rather than to cause.
     */
    idleTtlMs: z.int().min(1_000).max(86_400_000),
    /**
     * How many agents may be awake at once.
     *
     * Spike 0003 measured a dozen sessions holding at 264 MB each, flat across
     * scale, so memory is not what binds this — **tokens are**, and the budget
     * governor that would answer for them is M6. Until then this is the only
     * thing standing between a roster and a bill.
     */
    maxAwake: z.int().min(1).max(24),
  }),

  shutdown: z.strictObject({
    /**
     * How long draining may take before the process stops waiting.
     *
     * The upper bound exists because a larger value cannot be honoured: systemd
     * sends `SIGKILL` after `TimeoutStopSec`, so a deadline beyond that is a
     * promise the process is in no position to keep.
     */
    timeoutMs: z.int().positive().max(600_000),
  }),
});

export type Config = z.infer<typeof configSchema>;

/**
 * A setting whose value is a credential.
 *
 * Nothing in M1 uses it yet. ADR-0018 requires the mechanism to exist before the
 * first credential does, so that the first module needing one does not invent
 * its own handling under deadline.
 *
 * Validation deliberately checks nothing but presence. Zod does not echo values
 * in its messages, and a test in this package holds it to that — but the way to
 * be certain a secret never appears in a validation error is to never give a
 * validator a reason to describe it.
 */
export const secretSchema = z
  .string()
  .min(1)
  .transform((value) => new Secret(value));

/**
 * Where settings come from, in what order, and what happens when they are wrong.
 *
 * Three sources, each overriding the one before it: **defaults**, then a
 * **file**, then the **environment**. Nothing else, and no implicit name
 * mangling — the environment surface is an explicit table below, so
 * `CORTANA_SHUTDOWN_TIMEOUT_MS` maps to `shutdown.timeoutMs` because a line here
 * says it does, not because a rule guessed it.
 *
 * Every value carries its **provenance**. That costs almost nothing to record
 * and turns the two questions people actually ask — "why is this setting what it
 * is" and "which file do I edit" — into something the process can answer instead
 * of the operator having to reconstruct it. Spike 0010 spent a whole part
 * establishing the same thing about the provider's own settings cascade; it is
 * worth having about ours from the start.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AppError, PRODUCT_NAME } from '@cortana/core';
import { parse as parseToml } from 'smol-toml';
import { type Config, configSchema } from './schema.ts';

/** Derived rather than written down, because ADR-0002 requires renaming to stay cheap. */
const ENV_PREFIX = `${PRODUCT_NAME.toUpperCase()}_`;
const APP_DIR = PRODUCT_NAME.toLowerCase();
const FILE_NAME = 'config.toml';
const AGENTS_DIR = 'agents';

export type SettingSource = 'default' | 'file' | 'environment';

export interface LoadedConfig {
  readonly config: Config;
  /** Dotted setting path to where its value came from. */
  readonly provenance: ReadonlyMap<string, SettingSource>;
  /** The file that was read, or `null` if none was found. */
  readonly file: string | null;
}

interface Binding {
  /** The variable name after the prefix. */
  readonly name: string;
  readonly path: readonly string[];
  readonly parse?: (raw: string) => unknown;
}

/**
 * The complete environment surface.
 *
 * A value that fails to parse is passed through unchanged rather than replaced
 * with `NaN`, so the schema reports "expected number, received string" against a
 * named setting instead of a number that is not a number.
 */
const BINDINGS: readonly Binding[] = [
  { name: 'DATA_DIR', path: ['dataDir'] },
  { name: 'LOG_LEVEL', path: ['log', 'level'] },
  {
    name: 'AUDIT_RETENTION_DAYS',
    path: ['audit', 'retentionDays'],
    parse: (raw) => {
      const value = Number(raw);
      return Number.isFinite(value) ? value : raw;
    },
  },
  { name: 'AGENT_PERSONA', path: ['agent', 'persona'] },
  { name: 'ROSTER_DIR', path: ['roster', 'directory'] },
  { name: 'AGENT_TIER', path: ['agent', 'tier'] },
  {
    name: 'SHUTDOWN_TIMEOUT_MS',
    path: ['shutdown', 'timeoutMs'],
    parse: (raw) => {
      const value = Number(raw);
      return Number.isFinite(value) ? value : raw;
    },
  },
];

type Env = Readonly<Record<string, string | undefined>>;
type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function home(env: Env): string {
  return env['HOME'] ?? homedir();
}

/**
 * Where durable state lives when nothing says otherwise.
 *
 * `STATE_DIRECTORY` is set by systemd when the unit declares `StateDirectory=`,
 * and systemd has already created that directory with the right owner and mode.
 * Preferring it means the packaged service and a hand-run process agree without
 * the operator configuring anything. It is colon-separated when several were
 * requested; the first is ours.
 */
function defaultDataDir(env: Env): string {
  const fromSystemd = env['STATE_DIRECTORY']?.split(':')[0];
  if (fromSystemd) return fromSystemd;

  const xdg = env['XDG_STATE_HOME'];
  if (xdg) return join(xdg, APP_DIR);

  return join(home(env), '.local', 'state', APP_DIR);
}

function defaults(env: Env): Tree {
  return {
    dataDir: defaultDataDir(env),
    log: { level: 'info' },
    audit: { retentionDays: 90 },
    agent: {
      // Deliberately plain. A persona is the operator's to write, and a default
      // full of personality is one they have to undo rather than fill in.
      persona: 'You are Cortana, a careful assistant running on this machine.',
      tier: 'balanced',
      tools: [],
      readable: [],
      writable: [],
      confirm: 'writes',
    },
    roster: {
      directory: defaultRosterDirectory(env),
      // Long enough to hold a conversation together, short enough that an agent
      // nobody is talking to is not costing anything by the time you notice.
      idleTtlMs: 300_000,
      // CONCEPTS §3.3: "at any moment two or three of them are awake". Four
      // leaves room for that plus the one you are talking to.
      maxAwake: 4,
    },
    shutdown: { timeoutMs: 15_000 },
  };
}

/**
 * Where agent definitions live when nothing says otherwise.
 *
 * Beside the configuration file rather than beside the database, because a
 * definition is something a person writes and a database is something a process
 * owns. `CONFIGURATION_DIRECTORY` is set by systemd when the unit declares
 * `ConfigurationDirectory=`, which ours does — so the packaged service and a
 * hand-run process agree with nothing configured, the same arrangement
 * `dataDir` already has with `STATE_DIRECTORY`.
 */
function defaultRosterDirectory(env: Env): string {
  const fromSystemd = env['CONFIGURATION_DIRECTORY']?.split(':')[0];
  if (fromSystemd) return join(fromSystemd, AGENTS_DIR);

  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg) return join(xdg, APP_DIR, AGENTS_DIR);

  return join(home(env), '.config', APP_DIR, AGENTS_DIR);
}

/** Files to try, in order. The first that exists wins. */
function candidatePaths(env: Env): string[] {
  const xdg = env['XDG_CONFIG_HOME'];
  return [
    xdg ? join(xdg, APP_DIR, FILE_NAME) : join(home(env), '.config', APP_DIR, FILE_NAME),
    join('/etc', APP_DIR, FILE_NAME),
  ];
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AppError(`cannot read the configuration file at ${path}`, {
      category: 'config',
      code: 'config-file-unreadable',
      detail: { path },
      cause: error,
    });
  }
}

function loadFile(env: Env): { path: string; data: Tree } | null {
  const explicit = env[`${ENV_PREFIX}CONFIG`];

  // An explicit path that does not exist is a mistake, not a reason to fall
  // back: someone asked for that file specifically and would otherwise get a
  // silently different configuration.
  const paths = explicit ? [explicit] : candidatePaths(env);

  for (const path of paths) {
    const text = readIfPresent(path);
    if (text === null) continue;

    let parsed: unknown;
    try {
      parsed = parseToml(text);
    } catch (error) {
      throw new AppError(
        `the configuration file at ${path} is not valid TOML: ${(error as Error).message}`,
        { category: 'config', code: 'config-file-unparseable', detail: { path }, cause: error },
      );
    }

    if (!isTree(parsed)) {
      throw new AppError(`the configuration file at ${path} is not a table`, {
        category: 'config',
        code: 'config-file-unparseable',
        detail: { path },
      });
    }
    return { path, data: parsed };
  }

  if (explicit) {
    throw new AppError(`no configuration file at ${explicit}`, {
      category: 'config',
      code: 'config-file-missing',
      detail: { path: explicit, from: `${ENV_PREFIX}CONFIG` },
    });
  }
  return null;
}

function fromEnvironment(env: Env): { data: Tree; names: Map<string, string> } {
  const data: Tree = {};
  const names = new Map<string, string>();

  for (const binding of BINDINGS) {
    const variable = `${ENV_PREFIX}${binding.name}`;
    const raw = env[variable];
    if (raw === undefined) continue;

    let cursor = data;
    for (const key of binding.path.slice(0, -1)) {
      const next = cursor[key];
      if (isTree(next)) {
        cursor = next;
      } else {
        const child: Tree = {};
        cursor[key] = child;
        cursor = child;
      }
    }
    const leaf = binding.path.at(-1) as string;
    cursor[leaf] = binding.parse ? binding.parse(raw) : raw;
    names.set(binding.path.join('.'), variable);
  }

  return { data, names };
}

/** Overlays `source` onto `target`, recording where each leaf came from. */
function overlay(
  target: Tree,
  source: Tree,
  from: SettingSource,
  provenance: Map<string, SettingSource>,
  prefix = '',
): Tree {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isTree(value)) {
      const existing = target[key];
      target[key] = overlay(isTree(existing) ? existing : {}, value, from, provenance, path);
    } else {
      target[key] = value;
      provenance.set(path, from);
    }
  }
  return target;
}

function describeOrigin(
  path: string,
  provenance: ReadonlyMap<string, SettingSource>,
  file: string | null,
  variables: ReadonlyMap<string, string>,
): string {
  switch (provenance.get(path)) {
    case 'environment':
      return `set by ${variables.get(path) ?? 'the environment'}`;
    case 'file':
      return `set in ${file ?? 'the configuration file'}`;
    case 'default':
      return 'the built-in default';
    default:
      // No provenance means nothing supplied it, which is what a missing
      // required setting looks like from here.
      return 'not set anywhere';
  }
}

/**
 * Reads, merges, and validates the configuration.
 *
 * Throws an `AppError` in the `config` category on any problem, with a message
 * that names every offending setting and where its value came from. The daemon's
 * top-level handler prints that and exits; nothing about a wrong setting should
 * ever reach an operator as a stack trace.
 */
export function loadConfig(env: Env = process.env): LoadedConfig {
  const provenance = new Map<string, SettingSource>();
  const merged = overlay({}, defaults(env), 'default', provenance);

  const file = loadFile(env);
  if (file) overlay(merged, file.data, 'file', provenance);

  const environment = fromEnvironment(env);
  overlay(merged, environment.data, 'environment', provenance);

  const result = configSchema.safeParse(merged);
  if (result.success) {
    return { config: result.data, provenance, file: file?.path ?? null };
  }

  const lines: string[] = [];
  for (const issue of result.error.issues) {
    // `unrecognized_keys` reports the parent object's path and lists the keys
    // separately, so it is expanded here into one line per key. Without this the
    // message points at the object rather than at the line someone mistyped.
    const keys = issue.code === 'unrecognized_keys' ? issue.keys : [null];
    for (const key of keys) {
      const path = [...issue.path.map(String), ...(key === null ? [] : [key])].join('.');
      const where = describeOrigin(path, provenance, file?.path ?? null, environment.names);
      lines.push(`  ${path || '(root)'}\n      ${issue.message}\n      ${where}`);
    }
  }

  throw new AppError(
    `the configuration is not valid — ${lines.length} problem(s):\n\n${lines.join('\n\n')}\n`,
    {
      category: 'config',
      code: 'invalid-configuration',
      detail: { problems: lines.length, file: file?.path ?? '(none)' },
    },
  );
}

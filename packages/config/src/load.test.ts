import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppError } from '@cortana/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './load.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-config-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * An environment with nothing in it but a home directory that has no config —
 * and a machine-wide configuration directory of its own, so that what the
 * machine running the suite has installed in `/etc/cortana` cannot reach it.
 */
function bareEnv(): Record<string, string> {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(root, 'xdg-config'),
    CONFIGURATION_DIRECTORY: join(root, 'system-config'),
  };
}

function writeConfig(body: string): string {
  const dir = join(root, 'xdg-config', 'cortana');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.toml');
  writeFileSync(path, body);
  return path;
}

describe('defaults', () => {
  it('starts with no configuration at all', () => {
    const { config, file } = loadConfig(bareEnv());

    expect(file).toBeNull();
    expect(config.log.level).toBe('info');
    expect(config.shutdown.timeoutMs).toBe(15_000);
    expect(config.dataDir).toMatch(/\.local\/state\/cortana$/);
  });

  it('prefers the directory systemd created', () => {
    // StateDirectory= in the unit file sets this, and systemd has already made
    // the directory with the right owner. Preferring it means the packaged
    // service and a hand-run process agree with no configuration at all.
    const env = { ...bareEnv(), STATE_DIRECTORY: '/var/lib/cortana' };

    expect(loadConfig(env).config.dataDir).toBe('/var/lib/cortana');
  });

  it('takes the first entry when systemd gives several', () => {
    const env = { ...bareEnv(), STATE_DIRECTORY: '/var/lib/cortana:/var/lib/other' };

    expect(loadConfig(env).config.dataDir).toBe('/var/lib/cortana');
  });

  it('falls back to XDG_STATE_HOME before the home directory', () => {
    const env = { ...bareEnv(), XDG_STATE_HOME: '/somewhere/state' };

    expect(loadConfig(env).config.dataDir).toBe('/somewhere/state/cortana');
  });
});

describe('precedence', () => {
  it('lets the file override a default', () => {
    const path = writeConfig('[log]\nlevel = "debug"\n');
    const { config, file, provenance } = loadConfig(bareEnv());

    expect(file).toBe(path);
    expect(config.log.level).toBe('debug');
    expect(provenance.get('log.level')).toBe('file');
    expect(provenance.get('shutdown.timeoutMs')).toBe('default');
  });

  it('lets the environment override the file', () => {
    writeConfig('[log]\nlevel = "debug"\n');
    const env = { ...bareEnv(), CORTANA_LOG_LEVEL: 'error' };
    const { config, provenance } = loadConfig(env);

    expect(config.log.level).toBe('error');
    expect(provenance.get('log.level')).toBe('environment');
  });

  it('leaves settings the file did not mention alone', () => {
    writeConfig('[log]\nlevel = "warn"\n');
    const { config } = loadConfig(bareEnv());

    expect(config.log.level).toBe('warn');
    expect(config.shutdown.timeoutMs).toBe(15_000);
  });

  it('parses a number out of the environment', () => {
    const env = { ...bareEnv(), CORTANA_SHUTDOWN_TIMEOUT_MS: '30000' };

    expect(loadConfig(env).config.shutdown.timeoutMs).toBe(30_000);
  });
});

describe('finding the file', () => {
  it('reads the machine-wide file from the directory systemd made for the unit', () => {
    const env = bareEnv();
    const system = env['CONFIGURATION_DIRECTORY'] as string;
    mkdirSync(system, { recursive: true });
    writeFileSync(join(system, 'config.toml'), '[log]\nlevel = "warn"\n');

    const { config, file } = loadConfig(env);

    expect(file).toBe(join(system, 'config.toml'));
    expect(config.log.level).toBe('warn');
  });

  it('prefers the user’s own file to the machine-wide one', () => {
    const env = bareEnv();
    const system = env['CONFIGURATION_DIRECTORY'] as string;
    mkdirSync(system, { recursive: true });
    writeFileSync(join(system, 'config.toml'), '[log]\nlevel = "warn"\n');
    writeConfig('[log]\nlevel = "debug"\n');

    expect(loadConfig(env).config.log.level).toBe('debug');
  });

  it('says which file it could not read, rather than skipping it', () => {
    // The deployment target's own case: a machine-wide file that exists and
    // belongs to the service. Skipping it would run a different configuration
    // than the one installed, without a word.
    const env = bareEnv();
    const system = env['CONFIGURATION_DIRECTORY'] as string;
    mkdirSync(join(system, 'config.toml'), { recursive: true });

    expect(() => loadConfig(env)).toThrowError(/cannot read the configuration file at/);
  });

  it('reads the explicit path when one is given', () => {
    const path = join(root, 'elsewhere.toml');
    writeFileSync(path, 'dataDir = "/tmp/cortana-explicit"\n');
    const env = { ...bareEnv(), CORTANA_CONFIG: path };
    const { config, file } = loadConfig(env);

    expect(file).toBe(path);
    expect(config.dataDir).toBe('/tmp/cortana-explicit');
  });

  it('refuses to fall back when the explicit path does not exist', () => {
    // Falling back would silently run a different configuration than the one
    // that was asked for, which is worse than not starting.
    const env = { ...bareEnv(), CORTANA_CONFIG: join(root, 'absent.toml') };

    expect(() => loadConfig(env)).toThrowError(/no configuration file at/);
    try {
      loadConfig(env);
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('config-file-missing');
      expect(isAppError(error) && error.category).toBe('config');
    }
  });
});

describe('when something is wrong', () => {
  it('names the setting, the problem, and where the value came from', () => {
    const env = { ...bareEnv(), CORTANA_LOG_LEVEL: 'verbose' };
    let message = '';
    try {
      loadConfig(env);
    } catch (error) {
      message = (error as Error).message;
      expect(isAppError(error) && error.category).toBe('config');
      expect(isAppError(error) && error.code).toBe('invalid-configuration');
    }

    expect(message).toContain('log.level');
    expect(message).toContain('CORTANA_LOG_LEVEL');
  });

  it('points at the file when the file is what is wrong', () => {
    const path = writeConfig('[shutdown]\ntimeoutMs = -5\n');
    let message = '';
    try {
      loadConfig(bareEnv());
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('shutdown.timeoutMs');
    expect(message).toContain(path);
  });

  it('names a misspelled setting by the name that was typed', () => {
    writeConfig('[log]\nlevl = "debug"\n');

    expect(() => loadConfig(bareEnv())).toThrowError(/log\.levl/);
  });

  it('reports every problem at once rather than one per restart', () => {
    writeConfig('dataDir = "relative/path"\n[log]\nlevel = "chatty"\n');
    let message = '';
    try {
      loadConfig(bareEnv());
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('2 problem(s)');
    expect(message).toContain('dataDir');
    expect(message).toContain('log.level');
  });

  it('says where and why when the file is not valid TOML', () => {
    const path = writeConfig('[log\nlevel = "debug"\n');
    try {
      loadConfig(bareEnv());
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isAppError(error) && error.code).toBe('config-file-unparseable');
      expect((error as Error).message).toContain(path);
    }
  });

  it('rejects a non-numeric timeout by naming the variable that set it', () => {
    const env = { ...bareEnv(), CORTANA_SHUTDOWN_TIMEOUT_MS: 'soon' };
    let message = '';
    try {
      loadConfig(env);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('shutdown.timeoutMs');
    expect(message).toContain('CORTANA_SHUTDOWN_TIMEOUT_MS');
  });
});

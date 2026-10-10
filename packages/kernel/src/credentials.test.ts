import { isAppError } from '@cortana/core';
import { describe, expect, it } from 'vitest';
import { type CredentialSources, KEYCHAIN_SERVICE, readCredential } from './credentials.ts';
import { detectSecretProtection, type SecretRung } from './secrets.ts';

const VALUE = '123456:SECRET-token_value';

/** The protection a machine on `rung` reports, from the detection that really runs. */
function protectionAt(rung: SecretRung) {
  const present: Record<SecretRung, string[]> = {
    1: ['/run/systemd/system', '/usr/bin/systemd-creds', '/sys/class/tpm/tpm0'],
    2: ['/run/systemd/system', '/usr/bin/systemd-creds'],
    3: ['/usr/bin/security'],
    4: [],
  };
  const protection = detectSecretProtection({
    platform: rung === 3 ? 'darwin' : 'linux',
    exists: (path) => present[rung].includes(path),
    env: {},
  });
  expect(protection.rung).toBe(rung);
  return protection;
}

interface Machine {
  readonly files?: Record<string, string>;
  readonly modes?: Record<string, number>;
  readonly keychain?: Record<string, string>;
  readonly env?: Record<string, string>;
}

function sources(rung: SecretRung, machine: Machine = {}): CredentialSources {
  return {
    protection: protectionAt(rung),
    env: machine.env ?? {},
    dataDir: '/var/lib/cortana',
    readFile: (path) => {
      const text = machine.files?.[path];
      if (text === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      }
      return text;
    },
    modeOf: (path) => machine.modes?.[path] ?? 0o100600,
    keychain: (service, account) => machine.keychain?.[`${service}/${account}`] ?? null,
  };
}

/** The refusal, checked for the two things every refusal owes the operator. */
function refusal(read: () => unknown): { code: string; message: string } {
  try {
    read();
  } catch (error) {
    if (!isAppError(error)) throw error;
    expect(error.category).toBe('config');
    expect(error.message).toContain('"telegram-bot-token"');
    expect(JSON.stringify(error)).not.toContain('SECRET');
    return { code: error.code, message: error.message };
  }
  throw new Error('expected a refusal');
}

describe('rungs 1 and 2 — systemd-creds', () => {
  const service = { CREDENTIALS_DIRECTORY: '/run/credentials/cortana.service' };

  it.each([1, 2] as const)('reads what systemd decrypted for the service (rung %i)', (rung) => {
    const secret = readCredential(
      'telegram-bot-token',
      sources(rung, {
        env: service,
        files: { '/run/credentials/cortana.service/telegram-bot-token': `${VALUE}\n` },
      }),
    );

    expect(secret.expose()).toBe(VALUE);
  });

  it('tells a hand-started daemon to run as the service, rather than looking elsewhere', () => {
    // The rung-4 file is right there. Reading it would be reaching for the
    // bottom of the ladder because the top was inconvenient — the one thing
    // ADR-0018 says the ladder exists to prevent.
    const { code, message } = refusal(() =>
      readCredential(
        'telegram-bot-token',
        sources(2, { files: { '/var/lib/cortana/credentials/telegram-bot-token': VALUE } }),
      ),
    );

    expect(code).toBe('credential-needs-the-service');
    expect(message).toContain('run it as the service');
  });

  it('says how to create one the service was not given', () => {
    const { code, message } = refusal(() =>
      readCredential('telegram-bot-token', sources(2, { env: service })),
    );

    expect(code).toBe('credential-missing');
    expect(message).toContain('systemd-creds encrypt --with-key=auto --name=telegram-bot-token');
    expect(message).toContain('ImportCredential=telegram-bot-token');
  });
});

describe('rung 3 — the Keychain', () => {
  it('reads the item filed under this product and the credential’s name', () => {
    const secret = readCredential(
      'telegram-bot-token',
      sources(3, { keychain: { [`${KEYCHAIN_SERVICE}/telegram-bot-token`]: `${VALUE}\n` } }),
    );

    expect(secret.expose()).toBe(VALUE);
  });

  it('says how to add a missing one without putting it on the command line', () => {
    const { code, message } = refusal(() => readCredential('telegram-bot-token', sources(3)));

    expect(code).toBe('credential-missing');
    expect(message).toContain(
      `security add-generic-password -s ${KEYCHAIN_SERVICE} -a telegram-bot-token -w`,
    );
  });
});

describe('rung 4 — a file and its permissions', () => {
  const path = '/var/lib/cortana/credentials/telegram-bot-token';

  it('reads a file only its owner can read', () => {
    const secret = readCredential(
      'telegram-bot-token',
      sources(4, { files: { [path]: VALUE }, modes: { [path]: 0o100600 } }),
    );

    expect(secret.expose()).toBe(VALUE);
  });

  it.each([0o100644, 0o100640, 0o100604])('refuses one others can read (%o)', (mode) => {
    // On this rung the permission bits are the whole protection.
    const { code, message } = refusal(() =>
      readCredential(
        'telegram-bot-token',
        sources(4, { files: { [path]: VALUE }, modes: { [path]: mode } }),
      ),
    );

    expect(code).toBe('credential-exposed');
    expect(message).toContain(`chmod 600 ${path}`);
  });

  it('says where to put a missing one, and that it will not be encrypted', () => {
    const { code, message } = refusal(() => readCredential('telegram-bot-token', sources(4)));

    expect(code).toBe('credential-missing');
    expect(message).toContain(path);
    expect(message).toContain('plain file');
  });
});

describe('the value', () => {
  const at = (text: string) =>
    readCredential(
      'telegram-bot-token',
      sources(4, { files: { '/var/lib/cortana/credentials/telegram-bot-token': text } }),
    );

  it('loses the line ending an editor adds, and nothing else', () => {
    expect(at(`${VALUE}\r\n`).expose()).toBe(VALUE);
    expect(at(` ${VALUE}`).expose()).toBe(` ${VALUE}`);
  });

  it('is refused when empty, by saying so rather than by quoting it', () => {
    const { code } = refusal(() => at('\n'));
    expect(code).toBe('credential-empty');
  });

  it('comes back as a Secret, which no log line can print', () => {
    const secret = at(VALUE);
    expect(`${secret}`).not.toContain('SECRET');
    expect(JSON.stringify({ secret })).not.toContain('SECRET');
  });
});

describe('the name', () => {
  it.each(['../etc/passwd', 'a/b', '', 'Telegram', 'a--b', '-a'])(
    'cannot be a path or anything else unexpected (%s)',
    (name) => {
      expect(() => readCredential(name, sources(4))).toThrow(/not a credential name/);
    },
  );
});

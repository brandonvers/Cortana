/**
 * Reading a credential from wherever this machine keeps it — ADR-0018's store,
 * read side only.
 *
 * `secrets.ts` discovers which rung this machine stands on and reports it. This
 * reads from that rung and **only** that rung, because the ladder's one rule is
 * that the bottom is not reached for the moment the top is inconvenient: "that
 * was the error this ladder exists to prevent". A server whose credentials are
 * held by `systemd-creds` is not handed a plaintext file instead because the
 * daemon was started by hand; it is told to start it as the service.
 *
 * | Rung | Read from | Put there by |
 * |---|---|---|
 * | 1, 2 | `$CREDENTIALS_DIRECTORY/<name>`, which systemd decrypts before the process starts | `systemd-creds encrypt` into `/etc/credstore.encrypted/` |
 * | 3 | the login Keychain, service `cortana`, account `<name>` | `security add-generic-password` |
 * | 4 | `<dataDir>/credentials/<name>`, refused unless only its owner can read it | a person, with `chmod 600` |
 *
 * Every refusal is a configuration error that names the credential and gives
 * the command that would fix it, and **none of them carries the value**: a
 * credential that is present but unusable — empty, or readable by others — is
 * described by what is wrong with it, never by what it says.
 *
 * Nothing is written. There is one credential so far and a person puts it in
 * place once; a write path for it would be code with no caller.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Secret } from '@cortana/config';
import { AppError, PRODUCT_NAME } from '@cortana/core';
import type { SecretProtection } from './secrets.ts';

/** Where a credential's name is used as a filename, it must not be able to be a path. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The Keychain service everything is filed under. Derived, as ADR-0002 asks. */
export const KEYCHAIN_SERVICE = PRODUCT_NAME.toLowerCase();

/** Everything reading touches, so each rung can be tested on a machine that has another. */
export interface CredentialSources {
  readonly protection: SecretProtection;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dataDir: string;
  /** The file's text; throws with `code: 'ENOENT'` when there is none. */
  readonly readFile: (path: string) => string;
  /** The file's permission bits. */
  readonly modeOf: (path: string) => number;
  /** The stored value, or `null` when there is no such item. */
  readonly keychain: (service: string, account: string) => string | null;
}

export type ReadCredential = (name: string) => Secret;

export function readCredential(name: string, sources: CredentialSources): Secret {
  if (!NAME.test(name)) {
    // A defect rather than a configuration problem: names are constants in
    // this repository, and one that could be `../x` would read outside the
    // directory it names.
    throw new Error(`"${name}" is not a credential name`);
  }

  const { rung } = sources.protection;
  if (rung === 1 || rung === 2) return fromSystemd(name, sources);
  if (rung === 3) return fromKeychain(name, sources);
  return fromFile(name, sources);
}

function fromSystemd(name: string, sources: CredentialSources): Secret {
  const directory = sources.env['CREDENTIALS_DIRECTORY'];
  if (directory === undefined || directory === '') {
    throw missing(
      name,
      'credential-needs-the-service',
      `this machine keeps credentials with systemd-creds, and they reach the daemon only ` +
        'when systemd starts it — run it as the service rather than by hand',
    );
  }
  return parsed(name, readOrNull(join(directory, name), sources), () =>
    missing(
      name,
      'credential-missing',
      `it is not among the credentials the service was given. Create it with ` +
        `\`sudo systemd-creds encrypt --with-key=auto --name=${name} - ` +
        `/etc/credstore.encrypted/${name}\` (type the value, then Ctrl-D), make sure the unit ` +
        `has \`ImportCredential=${name}\`, and restart the service`,
    ),
  );
}

function fromKeychain(name: string, sources: CredentialSources): Secret {
  return parsed(name, sources.keychain(KEYCHAIN_SERVICE, name), () =>
    missing(
      name,
      'credential-missing',
      `it is not in the Keychain. Add it with \`security add-generic-password ` +
        `-s ${KEYCHAIN_SERVICE} -a ${name} -w\`, which asks for the value rather than ` +
        'taking it on the command line',
    ),
  );
}

function fromFile(name: string, sources: CredentialSources): Secret {
  const path = join(sources.dataDir, 'credentials', name);
  const text = readOrNull(path, sources);
  if (text !== null && (sources.modeOf(path) & 0o077) !== 0) {
    // Refused rather than used with a warning. On this rung the permission is
    // the entire protection, and a file others can read is no protection.
    throw missing(
      name,
      'credential-exposed',
      `${path} can be read by users other than its owner. Run \`chmod 600 ${path}\``,
    );
  }
  return parsed(name, text, () =>
    missing(
      name,
      'credential-missing',
      `there is no ${path}. Nothing on this machine can encrypt it, so it is a plain file: ` +
        `create it, put the value in it, and run \`chmod 600 ${path}\``,
    ),
  );
}

/** The value without the line ending an editor or `echo` adds, or a refusal. */
function parsed(name: string, text: string | null, absent: () => AppError): Secret {
  if (text === null) throw absent();
  const value = text.replace(/[\r\n]+$/, '');
  if (value.trim() === '') {
    throw missing(name, 'credential-empty', 'it is there, and it is empty');
  }
  return new Secret(value);
}

function readOrNull(path: string, sources: CredentialSources): string | null {
  try {
    return sources.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function missing(name: string, code: string, why: string): AppError {
  return new AppError(`the credential "${name}" cannot be read: ${why}`, {
    category: 'config',
    code,
    detail: { credential: name },
  });
}

/**
 * The real machine.
 *
 * The Keychain is asked through `security`, already on every Mac, so ADR-0018's
 * "no npm dependency" holds. Its exit status 44 is "no such item"; anything else
 * is a failure worth seeing, and its output is not repeated because on success
 * that output is the credential.
 */
export function machineCredentialSources(
  protection: SecretProtection,
  dataDir: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CredentialSources {
  return {
    protection,
    env,
    dataDir,
    readFile: (path) => readFileSync(path, 'utf8'),
    modeOf: (path) => statSync(path).mode,
    keychain: (service, account) => {
      try {
        return execFileSync(
          '/usr/bin/security',
          ['find-generic-password', '-s', service, '-a', account, '-w'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
      } catch (error) {
        if ((error as { status?: number }).status === 44) return null;
        throw new AppError(`the Keychain could not be read for "${account}"`, {
          category: 'unavailable',
          code: 'keychain-unreadable',
          detail: { status: (error as { status?: number }).status ?? -1 },
        });
      }
    },
  };
}

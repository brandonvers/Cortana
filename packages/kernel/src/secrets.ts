/**
 * Which protection this machine can give a credential, discovered rather than
 * configured.
 *
 * [ADR-0018](../../../docs/adr/0018-secrets-at-rest.md) sets out four rungs and
 * one rule about choosing between them: the rung is **discovered at runtime on
 * the machine the daemon is running on, never configured, and never pinned to
 * what the maintainer's hardware happens to support.** A machine that can seal a
 * secret to a TPM must get that without its owner configuring anything, and
 * nothing about this project's development hardware may take it away.
 *
 * ## What this does and does not do yet
 *
 * It reports. It does not store or fetch, because there is nothing to store: the
 * credentials ADR-0018 plans for arrive with modules, and no module exists. The
 * same discipline that keeps M1's database schema to one table applies here —
 * a store written ahead of its first caller is a guess that later has to be
 * either honoured or migrated away from.
 *
 * Reporting on its own is not a placeholder, though. It is the "announced at
 * boot, not silent" half of the ADR, and it is most useful **before** the first
 * credential exists: an operator learns what protection they would get while
 * they can still do something about it, rather than after they have typed a
 * password into a file.
 *
 * ## Why everything is injected
 *
 * The ADR says rung 1 "is the one that cannot be exercised locally or in CI,
 * which is exactly why it needs an explicit fake at the port boundary rather
 * than being trusted to work first time on someone else's hardware". Detection
 * takes its platform, its filesystem probe, and its environment as arguments, so
 * all four rungs are testable on a machine that supports one of them.
 */

/** Best first. See ADR-0018 for what each is worth. */
export type SecretRung = 1 | 2 | 3 | 4;

export interface SecretProtection {
  readonly rung: SecretRung;
  readonly mechanism: string;
  /**
   * Whether the key lives somewhere other than the filesystem it protects.
   *
   * This is the property the ladder exists to order by, and the one that must
   * never be overstated: only rung 1 is sealed. Rung 2 encrypts, which is worth
   * having, but a copied disk that includes `/var/lib/systemd/` yields
   * plaintext.
   */
  readonly sealed: boolean;
  readonly keyLocation: string;
  readonly detail: string;
  /** What was observed to reach this conclusion. */
  readonly evidence: Readonly<Record<string, boolean>>;
}

export interface DetectionProbes {
  readonly platform: NodeJS.Platform;
  readonly exists: (path: string) => boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** A TPM2 device, through the kernel's resource manager or directly. */
const TPM_DEVICES = ['/dev/tpmrm0', '/dev/tpm0'];
/** The conventional marker for "this machine was booted by systemd". */
const SYSTEMD_MARKER = '/run/systemd/system';
const SYSTEMD_CREDS = ['/usr/bin/systemd-creds', '/bin/systemd-creds'];
const SECURITY_CLI = '/usr/bin/security';

export function detectSecretProtection(probes: DetectionProbes): SecretProtection {
  const any = (paths: readonly string[]) => paths.some((path) => probes.exists(path));

  const systemdBooted = probes.exists(SYSTEMD_MARKER);
  const systemdCreds = any(SYSTEMD_CREDS);
  const tpm = any(TPM_DEVICES);
  // systemd sets this for every unit it starts. It separates "systemd is on this
  // machine" from "we were started by it", which is what decides whether
  // credentials can be passed in at all.
  const startedByUnit = Boolean(probes.env['INVOCATION_ID']);

  const evidence = { systemdBooted, systemdCreds, tpm, startedByUnit };

  if (probes.platform === 'linux' && systemdBooted && systemdCreds && tpm) {
    return {
      rung: 1,
      mechanism: 'systemd-creds, sealed to TPM2',
      sealed: true,
      keyLocation: 'the TPM, never on the filesystem',
      detail:
        'A copied disk, a synced backup, or a snapshot restored elsewhere yields ciphertext. ' +
        'Secrets are bound to this machine and must be re-entered after a hardware change.',
      evidence,
    };
  }

  if (probes.platform === 'linux' && systemdBooted && systemdCreds) {
    return {
      rung: 2,
      mechanism: 'systemd-creds, host key',
      sealed: false,
      keyLocation: '/var/lib/systemd/credential.secret, root-only',
      detail:
        'Encrypted with a root-only key held in a different file from the ciphertext, and ' +
        'decrypted into a tmpfs that disappears with the service. Not sealed: a copy of the ' +
        'disk that includes /var/lib/systemd/ yields plaintext. Adding a TPM2 device moves ' +
        'this to rung 1 with no configuration.',
      evidence,
    };
  }

  if (probes.platform === 'darwin' && probes.exists(SECURITY_CLI)) {
    return {
      rung: 3,
      mechanism: 'the macOS Keychain',
      sealed: false,
      keyLocation: 'the OS keystore',
      detail: 'Appropriate for the development machine. The deployment target is Linux.',
      evidence,
    };
  }

  return {
    rung: 4,
    mechanism: 'file permissions only',
    sealed: false,
    keyLocation: 'nowhere — nothing is encrypted',
    detail:
      'A credential on this machine is protected against other users on it and against ' +
      'nothing else: not a copied disk, not a backup. These are the realistic ways a home ' +
      "server's secrets escape.",
    evidence,
  };
}

/** Reads the real machine. Split out so the detection above stays a pure function. */
export function probeThisMachine(
  exists: (path: string) => boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): DetectionProbes {
  return { platform: process.platform, exists, env };
}

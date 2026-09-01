import { describe, expect, it } from 'vitest';
import { type DetectionProbes, detectSecretProtection, type SecretRung } from './secrets.ts';

/**
 * Every rung is tested on a machine that supports exactly one of them, which is
 * the whole reason detection takes its platform, filesystem and environment as
 * arguments. ADR-0018 asked for this in as many words: rung 1 "is the one that
 * cannot be exercised locally or in CI, which is exactly why it needs an
 * explicit fake at the port boundary rather than being trusted to work first
 * time on someone else's hardware".
 */
function machine(
  platform: NodeJS.Platform,
  present: readonly string[],
  env: Record<string, string> = {},
): DetectionProbes {
  return { platform, exists: (path) => present.includes(path), env };
}

const SYSTEMD = ['/run/systemd/system', '/usr/bin/systemd-creds'];

describe('rung 1 — sealed to hardware', () => {
  it('is reached on Linux with systemd and a TPM', () => {
    const result = detectSecretProtection(machine('linux', [...SYSTEMD, '/dev/tpmrm0']));

    expect(result.rung).toBe(1);
    expect(result.sealed).toBe(true);
    expect(result.keyLocation).toContain('TPM');
  });

  it('accepts the device without the kernel resource manager', () => {
    expect(detectSecretProtection(machine('linux', [...SYSTEMD, '/dev/tpm0'])).rung).toBe(1);
  });

  it('says that secrets will not survive a hardware change', () => {
    // The cost of sealing, and the thing an operator must know before a
    // recovery rather than during one.
    const result = detectSecretProtection(machine('linux', [...SYSTEMD, '/dev/tpmrm0']));

    expect(result.detail).toMatch(/re-entered after a hardware change/);
  });
});

describe('rung 2 — encrypted, not sealed', () => {
  // What the maintainer's own server reports: /dev/tpmrm0 is absent on it.
  const server = machine('linux', SYSTEMD);

  it('is reached on Linux with systemd and no TPM', () => {
    expect(detectSecretProtection(server).rung).toBe(2);
  });

  it('refuses to call itself sealed', () => {
    // The overstatement ADR-0018 forbids. Rung 2 encrypts, which is worth
    // having, and a copied disk that includes /var/lib/systemd/ still yields
    // plaintext.
    const result = detectSecretProtection(server);

    expect(result.sealed).toBe(false);
    expect(result.keyLocation).toContain('/var/lib/systemd/credential.secret');
    expect(result.detail).toMatch(/Not sealed/);
  });

  it('says that adding a TPM is all it would take', () => {
    expect(detectSecretProtection(server).detail).toMatch(/rung 1 with no configuration/);
  });
});

describe('rung 3 — the development machine', () => {
  it('is reached on macOS with the security command', () => {
    const result = detectSecretProtection(machine('darwin', ['/usr/bin/security']));

    expect(result.rung).toBe(3);
    expect(result.sealed).toBe(false);
  });
});

describe('rung 4 — nothing is encrypted', () => {
  it.each([
    ['a container with no systemd', machine('linux', [])],
    ['Linux with systemd but no systemd-creds', machine('linux', ['/run/systemd/system'])],
    ['macOS without the security command', machine('darwin', [])],
    ['some other platform entirely', machine('freebsd', [])],
    ['a TPM on a platform that cannot use it', machine('darwin', ['/dev/tpmrm0'])],
  ])('is reached on %s', (_name, probes) => {
    const result = detectSecretProtection(probes);

    expect(result.rung).toBe(4);
    expect(result.keyLocation).toContain('nothing is encrypted');
  });

  it('names what it does and does not protect against', () => {
    const result = detectSecretProtection(machine('linux', []));

    expect(result.detail).toMatch(/other users/);
    expect(result.detail).toMatch(/not a copied disk, not a backup/);
  });
});

describe('the ladder as a whole', () => {
  it('calls exactly one rung sealed', () => {
    const machines: [SecretRung, DetectionProbes][] = [
      [1, machine('linux', [...SYSTEMD, '/dev/tpmrm0'])],
      [2, machine('linux', SYSTEMD)],
      [3, machine('darwin', ['/usr/bin/security'])],
      [4, machine('linux', [])],
    ];

    for (const [rung, probes] of machines) {
      const result = detectSecretProtection(probes);
      expect(result.rung).toBe(rung);
      expect(result.sealed).toBe(rung === 1);
    }
  });

  it('shows what it looked at, so a surprising answer can be argued with', () => {
    const result = detectSecretProtection(machine('linux', SYSTEMD, { INVOCATION_ID: 'abc' }));

    expect(result.evidence).toEqual({
      systemdBooted: true,
      systemdCreds: true,
      tpm: false,
      startedByUnit: true,
    });
  });

  it('separates being started by systemd from systemd being installed', () => {
    // Different questions. One decides whether credentials can be passed in at
    // all; the other decides what they would be protected with.
    const notAUnit = detectSecretProtection(machine('linux', SYSTEMD));
    const aUnit = detectSecretProtection(machine('linux', SYSTEMD, { INVOCATION_ID: 'x' }));

    expect(notAUnit.rung).toBe(aUnit.rung);
    expect(notAUnit.evidence['startedByUnit']).toBe(false);
    expect(aUnit.evidence['startedByUnit']).toBe(true);
  });
});

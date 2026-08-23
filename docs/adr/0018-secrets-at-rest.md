# 0018. Secrets are sealed by the OS, and can never reach a log line

**Status:** Accepted
**Date:** 2026-08-23

## Context

[ADR-0001](0001-model-access-behind-a-port.md) keeps the *provider* credential
out of this system entirely: the provider's own tooling holds its own
authentication and Cortana never sees it. That removes the most valuable secret
from the threat model, and it removes it by architecture rather than by care.

What remains arrives with modules — a mailbox password, a calendar token, an API
key for a connector. **None exists yet**, which makes this the right moment to
choose the mechanism and the wrong moment to build encryption around nothing.

The requirement is a standing one for this project and it is not conditional on
the user's judgement: **credentials are protected whether or not their owner
considers them important.** The failure being designed against is the ordinary
one — a token in a log file, a password in a stack trace, a config file in a
backup — not a targeted attacker.

Those are two different problems and they need two different answers:

1. **In process**, a secret must not be able to reach a log line, an audit
   record, or an error message. This is where credentials actually leak in
   practice, and no storage mechanism helps with it.
2. **At rest**, a secret must survive being read by someone who has the file.

Four mechanisms were considered for the second. They differ in one property that
turns out to decide it: **whether the key sits on the same disk as the thing it
protects.**

## Decision

**Both layers, and the first one is not optional.**

### The `Secret` type

Any credential in memory is a `Secret`, an opaque type whose value is reachable
only through an explicit unwrap at the point of use. Its `toString`, its template
interpolation, and its JSON serialisation return a redaction, so the ordinary
ways a value reaches a log are closed by the type rather than by review. A test
proves it, and the logger's own redaction is configured as a second layer.

This holds regardless of anything below it.

### The `SecretStore` port

Storage at rest sits behind one port with platform implementations:

- **Linux: `systemd-creds`, sealed to the TPM.** The credential is encrypted with
  a key held in the TPM, not on the filesystem, and systemd decrypts it into
  `$CREDENTIALS_DIRECTORY` at service start. The daemon reads a file it never has
  the key for.
- **macOS: the Keychain**, through the `security` command already on the system.
- **Fallback: a `0600` file**, when neither is available.

**The fallback is announced at boot, not silent.** A system running with
file-permission protection says so in its startup log and on the dashboard when
one exists. A security property that quietly degrades is worse than one that was
never claimed.

No npm dependency is added by any of this.

## Consequences

- **The key is not on the disk it protects.** This is the whole reason for the
  choice: a copied disk, a synced backup, or a snapshot restored elsewhere yields
  ciphertext and nothing else. Every other option on the table fails that test or
  needs a daemon to pass it.
- **Sealing to the TPM binds secrets to the machine.** A restore onto new
  hardware cannot decrypt them, so **secrets must be re-entered after a hardware
  change** — and the documentation has to say so before someone discovers it
  during a recovery. This is a real cost and it is accepted knowingly.
- **Two implementations to maintain**, plus a fallback: three code paths where a
  simpler answer has one. The port keeps that contained, and the fallback is the
  path CI exercises since neither runner has a TPM.
- **A precondition that is documented rather than verified.** This rests on
  systemd's documented interface; whether the target machine exposes a TPM2
  device (`/dev/tpmrm0`) has not been checked. If it does not, the Linux path is
  `systemd-creds` without TPM sealing — still host-bound, key in
  `/var/lib/systemd/credential.secret` rather than in hardware — and that is a
  weaker claim which must be reported as such rather than described as sealed.
- **The security property is enforced twice**, which is this project's standing
  rule: the type prevents the leak that actually happens, and the OS prevents the
  one that is worse when it does. Neither is asked to cover the other's case.
- Modules receive secrets already unwrapped at the call site, so a module author
  cannot accidentally serialise one — but nothing stops a module logging what it
  was handed. That boundary is a module-host concern and belongs with the
  supervision work, not here.

## Alternatives considered

**File permissions alone (`0600` plus `LoadCredential`).** Costs nothing and is
kept as the fallback. Rejected as the default because it protects against other
users on the box and nothing else — not a copied disk, not a backup, which are
the realistic ways a home server's secrets escape.

**An encrypted secrets file (`age`, `sops`).** Genuinely good, and it makes
backups safe by default. Rejected because it adds a dependency and a
key-management story the user has to understand, and because the common
deployment puts the key on the same disk as the ciphertext — which protects
considerably less than it appears to. The chosen option gets the same property
with no dependency and no key for the user to hold.

**The OS keychain on both platforms.** Correct on macOS and adopted there.
Rejected on Linux: libsecret needs a session daemon on a headless server, which
is exactly the "install and supervise a service" burden
[ADR-0011](0011-no-redis.md) rejected for Redis.

**Encrypting the database itself (SQLCipher).** Rejected: it replaces the driver
chosen in [ADR-0010](0010-sqlite-storage.md), encrypts a great deal that is not
secret, and still leaves the key somewhere.

## Revisit when

A module needs a secret that must survive a hardware migration, which the TPM
binding forbids — that is a real conflict and it needs a stated answer rather
than a workaround. Or a target platform appears with neither systemd nor a
keychain, at which point the fallback stops being an edge case.

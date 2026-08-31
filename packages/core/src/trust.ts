/**
 * Trust level carried by every piece of content entering the system.
 *
 * This is the one type that exists this early because it is a load-bearing
 * security concept rather than an implementation detail: content arrives
 * `untrusted`, and only a quarantine agent's verdict can change that. The
 * downgrade from a higher level to `untrusted` is one-way.
 */
export type TrustLevel = 'owner' | 'system' | 'untrusted';

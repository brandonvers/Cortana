/**
 * The product's identity, resolved from exactly one place.
 *
 * `docs/adr/0002-project-name.md` records why this is a single constant rather
 * than a string repeated across the codebase: "Cortana" is a Microsoft
 * trademark, adopted here for a non-commercial project with the maintainer's
 * acceptance of that risk. The agreed mitigation is that renaming must stay
 * cheap. So no other module may hard-code the product name — import it from
 * here — and the package scope must stay mechanically renameable.
 */
export const PRODUCT_NAME = 'Cortana';

/** The npm scope every internal package lives under. */
export const PACKAGE_SCOPE = '@cortana';

/**
 * Trust level carried by every piece of content entering the system.
 *
 * This is the one type that exists this early because it is a load-bearing
 * security concept rather than an implementation detail: content arrives
 * `untrusted`, and only a quarantine agent's verdict can change that. The
 * downgrade from a higher level to `untrusted` is one-way.
 */
export type TrustLevel = 'owner' | 'system' | 'untrusted';

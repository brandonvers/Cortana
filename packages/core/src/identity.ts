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

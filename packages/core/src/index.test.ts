import { describe, expect, it } from 'vitest';
import { PACKAGE_SCOPE, PRODUCT_NAME, type TrustLevel } from './index.ts';

describe('product identity', () => {
  it('exposes a non-empty product name', () => {
    expect(PRODUCT_NAME).toBeTruthy();
  });

  it('derives the package scope from the product name', () => {
    // Guards the rename requirement in ADR-0002: if someone renames the product
    // without renaming the scope, or the reverse, this fails loudly rather than
    // leaving the two to drift apart.
    expect(PACKAGE_SCOPE).toBe(`@${PRODUCT_NAME.toLowerCase()}`);
  });
});

describe('trust levels', () => {
  it('treats untrusted as an assignable level', () => {
    const level: TrustLevel = 'untrusted';
    expect(level).toBe('untrusted');
  });
});

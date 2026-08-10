# 0009. TypeScript 7 with Node's native type stripping

**Status:** Accepted
**Date:** 2026-08-10

## Context

TypeScript 7.0 replaced the compiler with a native port, delivering roughly an
order of magnitude faster builds. It shipped **without a public programmatic
compiler API** — that is scheduled for 7.1 — which broke every tool that reaches
into the compiler: `typescript-eslint`, `ts-jest`, `ts-morph`, and the template
tooling for several UI frameworks. Microsoft ships a compatibility shim for
projects that need the old API alongside the new compiler.

Separately, Node gained **stable type stripping**: it executes `.ts` files
directly by removing type annotations, with no build step and no loader.

## Decision

**TypeScript 7, with Node running `.ts` directly in development and `tsc`
emitting for production.**

Three compiler settings make this work and are not stylistic:

- **`erasableSyntaxOnly`** — type stripping can only remove syntax that erases to
  nothing, so the compiler rejects anything that would not survive it: no `enum`,
  no `namespace`, no constructor parameter properties. Anything that typechecks is
  then guaranteed to run.
- **`allowImportingTsExtensions` with `rewriteRelativeImportExtensions`** — Node
  needs a relative import to name the file that exists on disk (`./thing.ts`);
  `tsc` normally forbids that. The pair is the supported way to have both: source
  imports `.ts`, and `tsc` rewrites the specifier to `.js` when it emits.
- **`verbatimModuleSyntax`** — type-only imports must say so, which type stripping
  requires to know what to remove.

## Consequences

- **The TypeScript 7 API break does not affect this project.** Every tool in the
  stack was chosen for other reasons and none reaches into the compiler: Biome is
  written in Rust, Vitest transforms with esbuild, type stripping uses SWC, and
  the migration tool for the query layer bundles esbuild. This was verified by
  running the toolchain, not inferred.
- Development has **no build step**. `node file.ts` runs.
- Typechecking is fast enough to run on every change rather than being batched.
- **A standing constraint on contributors:** the code must stay erasable. This is
  written into `CONTRIBUTING.md`, and the compiler enforces it rather than review.
- **A residual risk:** a future tool that needs the compiler API will fail. The
  compatibility shim exists for that case and is noted in `CONTRIBUTING.md`
  rather than pre-installed.

## Alternatives considered

**Stay on TypeScript 6.** Safe, and it keeps every tool working. Rejected — the
break does not reach us, and adopting later means migrating a larger codebase.

**TypeScript 7 with `tsx` for development.** `tsx` was the plan until type
stripping turned out to be stable in the Node version already chosen. Rejected as
a dependency that earns nothing.

**Bundling for production.** Rejected: bundling breaks native addons, and the
process starts once and runs for months, so start-up cost is irrelevant.

## Revisit when

TypeScript 7.1 ships the stable compiler API, at which point the residual risk
above disappears and the note in `CONTRIBUTING.md` can be removed.

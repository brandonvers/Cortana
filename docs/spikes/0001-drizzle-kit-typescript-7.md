# Spike 0001 — Does drizzle-kit work under TypeScript 7?

**Date:** 2026-08-10
**Verdict:** ✅ **Pass**
**Decides:** whether the project can adopt TypeScript 7 now or must wait for 7.1

---

## Why this spike existed

TypeScript 7.0 shipped the native compiler **without a public programmatic
compiler API**; the stable API is scheduled for 7.1. That break took out every
tool that reaches into the compiler — `typescript-eslint`, `ts-jest`, `ts-morph`,
and the template tooling for several UI frameworks.

`drizzle-kit` reads a TypeScript schema file and a TypeScript config file. If it
did that through the compiler API, TypeScript 7 would be unusable here until 7.1
lands, and the whole toolchain decision would have to be deferred.

## Pass criterion, stated before running

`drizzle-kit generate` produces a correct migration from a TypeScript schema
file, with TypeScript 7 as the only installed TypeScript, **and** `tsc --noEmit`
passes on the same sources under the project's intended strict settings.

## Versions

| Package | Version |
|---|---|
| Node.js | 24.19.0 |
| typescript | 7.0.2 |
| drizzle-kit | 0.31.10 |
| drizzle-orm | 0.45.2 |
| better-sqlite3 | 13.0.3 |

Compiler options in force: `strict`, `exactOptionalPropertyTypes`,
`erasableSyntaxOnly`, `verbatimModuleSyntax`, `module: nodenext`.

## What happened

```
tsc --noEmit                              PASS

drizzle-kit generate
  Reading config file 'drizzle.config.ts'
  2 tables
  agents 5 columns 1 indexes 0 fks
  memory_items 4 columns 0 indexes 1 fks
  [✓] migration file written
  exit 0
```

The generated SQL was correct: column types, defaults, the index, and the foreign
key all as declared.

## Why it passes

`drizzle-kit` bundles **esbuild** to read config and schema files. It never
touches the TypeScript compiler API, so the missing 7.0 API is irrelevant to it.

The same reasoning covers the rest of the toolchain, and the coincidence is worth
naming:

| Tool | Reaches into the TS compiler? | |
|---|---|---|
| Biome | No — written in Rust | ✅ |
| Vitest | No — esbuild | ✅ |
| Node type stripping | No — SWC | ✅ |
| drizzle-kit | No — esbuild | ✅ **verified here** |
| ESLint / typescript-eslint | **Yes** | not used |
| ts-jest | **Yes** | not used |

Biome was chosen over ESLint and Vitest over Jest for unrelated reasons. Those
choices happened to move the entire TypeScript 7 blast radius outside this
project.

## What it changes

Nothing structural. It unblocks TypeScript 7 immediately instead of waiting for
7.1. Recorded as [ADR-0009](../adr/0009-typescript-7-type-stripping.md).

## Residual risk

A future tool that needs the compiler API — a codegen step, a lint rule, an API
extractor — will fail under TypeScript 7.0. Microsoft ships a compatibility shim
for exactly this. It is noted in `CONTRIBUTING.md` rather than pre-installed,
because installing it now would be solving a problem nobody has.

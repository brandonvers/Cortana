import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads this file and the schema through esbuild rather than through
 * the TypeScript compiler API, which is why spike 0001 found the migration
 * tooling usable under TypeScript 7 at all — the 7.0 release shipped without a
 * public compiler API and took out every tool that reaches for one.
 */
export default defineConfig({
  dialect: 'sqlite',
  // Tables live with the package that owns them; the migration history stays
  // here, single and ordered, which is the property ADR-0010 cares about. A new
  // package with tables adds a line rather than editing a file everyone shares.
  schema: [
    './src/schema.ts',
    '../audit/src/schema.ts',
    '../roster/src/schema.ts',
    '../reports/src/schema.ts',
    '../kernel/src/schema.ts',
  ],
  out: './migrations',
});

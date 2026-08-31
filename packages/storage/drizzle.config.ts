import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit reads this file and the schema through esbuild rather than through
 * the TypeScript compiler API, which is why spike 0001 found the migration
 * tooling usable under TypeScript 7 at all — the 7.0 release shipped without a
 * public compiler API and took out every tool that reaches for one.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './migrations',
});

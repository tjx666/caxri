import { defineConfig } from 'drizzle-kit';

/**
 * Used only to generate SQL migrations checked into `src/runtime/store/migrations/`. The
 * generated SQL is imported as a raw string at build time (see `src/runtime/store/sqlite.ts`);
 * drizzle's `migrate()` (which reads migration files from disk at runtime) is never used, since
 * the Runtime ships as a bundled utility process without guaranteed filesystem access to source
 * paths.
 */
export default defineConfig({
    dialect: 'sqlite',
    schema: './src/runtime/store/schema.ts',
    out: './src/runtime/store/migrations',
});

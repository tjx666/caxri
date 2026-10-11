import { defineConfig } from 'drizzle-kit';

/**
 * Used only to generate SQL migrations checked into `apps/server/src/domains/db/migrations/`. The generated SQL is
 * imported as a raw string at build time (see `apps/server/src/domains/db/connection.ts`); drizzle's `migrate()` (which
 * reads migration files from disk at runtime) is never used, since the Runtime ships as a bundled utility process
 * without guaranteed filesystem access to source paths.
 */
export default defineConfig({
    dialect: 'sqlite',
    schema: './apps/server/src/domains/db/full-schema.ts',
    out: './apps/server/src/domains/db/migrations',
});

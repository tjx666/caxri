import { z } from 'zod';

/**
 * The most recent clean-install cutoff rebuild of the database: when it ran, the schema version the old database held,
 * and where the pre-rebuild copy was kept. Present only after a rebuild; `backupPath` is home-normalized by every
 * reader that exposes it, so it never carries an account name.
 */
export const lastDatabaseRebuildSchema = z.strictObject({
    at: z.number().int().positive(),
    fromVersion: z.number().int().nonnegative(),
    backupPath: z.string().min(1).max(4096),
});

export type LastDatabaseRebuild = z.infer<typeof lastDatabaseRebuildSchema>;

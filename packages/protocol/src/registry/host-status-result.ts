import { z } from 'zod';

import { desktopStatusResultSchema } from '../desktop/desktop-contract.js';
import { identifierSchema } from '../domain/identifiers.js';
import { lastDatabaseRebuildSchema } from './database-rebuild.js';

/**
 * Whether Server Core is holding the Mac awake for working Agents (`power.keepAwakeWhileAgentsWork`), and since when.
 * Always inactive on a platform without a sleep assertion.
 */
const keepAwakeStatusSchema = z.strictObject({
    active: z.boolean(),
    since: z.number().int().positive().optional(),
});

/**
 * `host.status`: the running Server Core's identity, build, load, and Desktop attachment, kept beside the registry so
 * `methods` stays within the source-size ratchet.
 */
export const hostStatusResultSchema = z.object({
    profileId: identifierSchema,
    version: z.string().min(1).max(100),
    /**
     * Build commit for stale-Host detection; package version alone misses dev rebuilds.
     */
    commit: z.string().min(1).max(100).optional(),
    /**
     * Unique per build invocation. Commit alone cannot distinguish two dev builds of the same (possibly dirty)
     * checkout, so this is what the Desktop compares to decide a detached Host runs stale code and must be replaced.
     */
    buildId: z.string().min(1).max(100).optional(),
    pid: z.number().int().positive(),
    startedAt: z.number().int().positive(),
    clientCount: z.number().int().nonnegative(),
    activePtyCount: z.number().int().nonnegative(),
    protocolVersion: z.number().int().positive(),
    protocolCompatible: z.boolean(),
    desktop: desktopStatusResultSchema,
    lastDatabaseRebuild: lastDatabaseRebuildSchema.optional(),
    keepAwake: keepAwakeStatusSchema,
});

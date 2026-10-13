import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';

export const MOBILE_CHANGES_MAX_FILES = 100;
export const MOBILE_CHANGES_MAX_PATCH_BYTES = 48 * 1_024;
export const MOBILE_CHANGES_MAX_PATCH_LINES = 1_000;

const mobileChangedFileSchema = z.strictObject({
    repositoryId: identifierSchema,
    repositoryName: z.string().min(1).max(100),
    path: z.string().min(1).max(2_048),
    originalPath: z.string().min(1).max(2_048).optional(),
    status: z.enum(['M', 'A', 'D', 'R']),
    /**
     * Absent when Git has no line count for the file (binary, or an over-cap untracked file).
     */
    additions: z.number().int().nonnegative().optional(),
    deletions: z.number().int().nonnegative().optional(),
});

export const mobileChangesListResultSchema = z.strictObject({
    isRepository: z.boolean(),
    files: z.array(mobileChangedFileSchema).max(MOBILE_CHANGES_MAX_FILES),
    total: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    truncated: z.boolean(),
});

export const mobileChangesDiffResultSchema = z.discriminatedUnion('status', [
    z.strictObject({
        status: z.literal('available'),
        patch: z
            .string()
            .min(1)
            .refine(
                (patch) => new TextEncoder().encode(patch).length <= MOBILE_CHANGES_MAX_PATCH_BYTES,
                'Mobile patch exceeds the byte limit',
            ),
    }),
    z.strictObject({ status: z.literal('binary') }),
    z.strictObject({ status: z.literal('oversized') }),
    z.strictObject({ status: z.literal('stale') }),
]);

export type MobileChangesListResult = z.infer<typeof mobileChangesListResultSchema>;
export type MobileChangesDiffResult = z.infer<typeof mobileChangesDiffResultSchema>;

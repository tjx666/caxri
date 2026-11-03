import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';

export const MOBILE_CHANGES_MAX_FILES = 100;
export const MOBILE_CHANGES_MAX_PATCH_BYTES = 48 * 1_024;
export const MOBILE_CHANGES_MAX_PATCH_LINES = 1_000;

/**
 * Which change set the Changes tab lists, matching Desktop Source Control's three modes: the uncommitted working tree,
 * the HEAD commit, or the current branch's pull request (base...head).
 */
export const mobileChangesModeSchema = z.enum(['working', 'commit', 'pull-request']);

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

/**
 * What a non-working mode is showing for one repository, so the phone can name the commit or pull request above the
 * file list. A repository without a commit or pull request contributes no context.
 */
const mobileChangesContextSchema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('commit'),
        repositoryId: identifierSchema,
        shortSha: z.string().min(7).max(12),
        subject: z.string().max(4_096),
    }),
    z.strictObject({
        kind: z.literal('pull-request'),
        repositoryId: identifierSchema,
        number: z.number().int().positive(),
        title: z.string().max(4_096),
    }),
]);

export const mobileChangesListResultSchema = z.strictObject({
    isRepository: z.boolean(),
    /**
     * Uncommitted working-tree files across the Session's repositories. A non-working mode uses it to say how much work
     * the commit or pull request view is not showing.
     */
    uncommittedCount: z.number().int().nonnegative(),
    contexts: z.array(mobileChangesContextSchema).max(32),
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

export type MobileChangesMode = z.infer<typeof mobileChangesModeSchema>;
export type MobileChangesContext = z.infer<typeof mobileChangesContextSchema>;
export type MobileChangesListResult = z.infer<typeof mobileChangesListResultSchema>;
export type MobileChangesDiffResult = z.infer<typeof mobileChangesDiffResultSchema>;

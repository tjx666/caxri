import { z } from 'zod';

import { identifierSchema } from './domain.js';

/**
 * Lines a Session's Workbench Root has changed, summed across its repositories.
 *
 * Measured from where the checked-out branch forked off the remote default branch to the working tree, so it covers the
 * branch's commits, staged and unstaged edits, and new files alike: an Agent that commits as it goes keeps its count
 * instead of dropping to zero with every commit. A root checked out on the default branch itself (or with no resolvable
 * remote default) measures against `HEAD`, which is its uncommitted work only.
 *
 * The count belongs to the working tree, not to the Session's Agent: Sessions sharing one root report the same numbers.
 */
export const sessionDiffStatSchema = z.object({
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
});

export const sessionDiffStatsSchema = z.object({
    /**
     * Keyed by Session id. Sessions whose root is not a repository, or whose read failed, are omitted.
     */
    stats: z.record(identifierSchema, sessionDiffStatSchema),
});

export type SessionDiffStat = z.infer<typeof sessionDiffStatSchema>;
export type SessionDiffStats = z.infer<typeof sessionDiffStatsSchema>;

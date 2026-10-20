import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import {
    projectStatusStateSchema,
    pullRequestMergeBlockerSchema,
} from '../domain/project-status-state.js';
import { sessionPullRequestStateSchema } from '../domain/session-pull-request.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * How many failed check names the phone receives; the sheet names a few and counts the rest, like Desktop's merge
 * confirmation.
 */
export const MOBILE_PULL_REQUEST_FAILED_CHECK_NAMES = 3;

/**
 * The pull request a Session delivers, projected from the Desktop Status panel's summary onto what the phone's merge
 * sheet shows. `mergeBlocker` is the same closed reason Desktop's merge button reads, so both surfaces agree on whether
 * a merge is offered, confirmed, or refused.
 */
const mobilePullRequestSchema = z.strictObject({
    repositoryId: z.string().min(1).max(512),
    number: z.number().int().positive(),
    title: z.string().max(1_024),
    url: z.url(),
    lifecycle: sessionPullRequestStateSchema.optional(),
    /**
     * The check rollup after the user's ignored checks were filtered out.
     */
    checks: projectStatusStateSchema,
    checkCount: z.number().int().nonnegative(),
    failedChecks: z.array(z.string().max(200)).max(MOBILE_PULL_REQUEST_FAILED_CHECK_NAMES),
    failedCheckCount: z.number().int().nonnegative(),
    /**
     * The head the merge is pinned to; absent while GitHub has not reported it, which leaves nothing to merge yet.
     */
    headSha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .optional(),
    mergeBlocker: pullRequestMergeBlockerSchema.optional(),
    /**
     * The branch the pull request merges into, and the method the merge would use right now; both absent when Project
     * Status could not read them.
     */
    baseBranch: z.string().min(1).max(255).optional(),
    mergeMethod: z.enum(['merge', 'rebase', 'squash']).optional(),
});

/**
 * A Session's pull request and the paired device's merge. The read is open to every role; the merge is `control` only
 * and goes through the same `git.mergePullRequest` Desktop uses, pinned to the head the phone showed.
 */
export const mobilePullRequestMethods = {
    'mobile.pullRequest.read': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({ sessionId: identifierSchema }),
        /**
         * `pullRequest` is absent when the Session delivers none, or Project Status could not read it.
         */
        result: z.strictObject({ pullRequest: mobilePullRequestSchema.optional() }),
    },
    'mobile.pullRequest.merge': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({
            sessionId: identifierSchema,
            repositoryId: z.string().min(1).max(512),
            number: z.number().int().positive(),
            headSha: z.string().regex(/^[0-9a-f]{40}$/),
        }),
        result: z.strictObject({ method: z.enum(['squash', 'merge', 'rebase']) }),
    },
} as const satisfies Record<string, MethodSpec>;

export type MobilePullRequest = z.infer<typeof mobilePullRequestSchema>;

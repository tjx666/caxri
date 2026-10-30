import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './identifiers.js';
import { projectStatusStateSchema } from './project-status-state.js';

export const sessionPullRequestStateSchema = z.enum(['draft', 'open', 'merged', 'closed']);

/**
 * Why a pull request lookup failed, as a closed reason the Renderer turns into recovery copy in the interface language
 * (and the command to run, for the CLI reasons). The Server sends no sentence: CLI stderr can carry private repository
 * data, and a fixed English hint could not follow `workbench.language`.
 */
export const pullRequestUnavailableSchema = z.object({
    reason: z.enum([
        'not-found',
        'not-logged-in',
        'not-linked',
        'permission-denied',
        'rate-limited',
        'timeout',
        'network',
        'tls',
        'other',
    ]),
    /**
     * Epoch milliseconds when a paused lookup resumes by itself; only set for `rate-limited`. The Renderer re-checks it
     * against its own clock, so a snapshot served after the deadline falls back to the generic sentence.
     */
    retryAt: z.number().int().nonnegative().optional(),
});

/**
 * The GitHub pull request a Session is delivering, projected onto the PrimarySidebar row. `source` records how the link
 * was discovered: `agent` when the Session's primary Agent created or discussed it in its transcript, `branch` when it
 * was looked up from the Workbench root's checked-out branch.
 */
/**
 * The production deployment built from this pull request's merge commit.
 *
 * Present only when the hosting provider's current production deployment was built from exactly this pull request's
 * merge commit, which is what makes it this Session's delivery rather than the project's general deployment state. A
 * later merge moves production to another commit, and the field disappears from the row it used to describe.
 */
export const sessionDeploymentSchema = z.object({
    state: projectStatusStateSchema,
});

export const sessionPullRequestSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.url(),
    state: sessionPullRequestStateSchema,
    /**
     * Aggregated CI check rollup; absent when GitHub reported no checks.
     */
    checks: projectStatusStateSchema.optional(),
    deployment: sessionDeploymentSchema.optional(),
    source: z.enum(['agent', 'branch']),
    /**
     * When GitHub merged the pull request, in epoch milliseconds; present only for a merged pull request whose
     * timestamp GitHub reported. Server Core compares it with the Session's Agent turns to tell an Agent's own merge
     * from one made elsewhere.
     */
    mergedAt: z.number().optional(),
});

export const sessionPullRequestsSchema = z.object({
    /**
     * Keyed by Session id; Sessions without a discovered pull request are omitted.
     */
    pullRequests: z.record(identifierSchema, sessionPullRequestSchema),
    /**
     * A failed lookup is separate from a confirmed branch without a pull request.
     */
    unavailable: z.record(identifierSchema, pullRequestUnavailableSchema).optional(),
    refreshedAt: z.number(),
});

export type SessionDeployment = z.infer<typeof sessionDeploymentSchema>;
export type SessionPullRequest = z.infer<typeof sessionPullRequestSchema>;
export type SessionPullRequestState = z.infer<typeof sessionPullRequestStateSchema>;
export type PullRequestUnavailable = z.infer<typeof pullRequestUnavailableSchema>;
export type SessionPullRequests = z.infer<typeof sessionPullRequestsSchema>;

/**
 * Every active Session's discovered pull request in one read, so the PrimarySidebar polls a single method instead of
 * one delivery-CLI query per row.
 */
export const sessionPullRequestMethods = {
    'session.pullRequests': {
        ...commandPolicy('server', 'read'),
        params: z.object({}).default({}),
        result: sessionPullRequestsSchema,
    },
    /**
     * Asks the Server to re-read one Session's delivery status past its caches because the window just regained focus:
     * the user most likely merged or pushed somewhere else. The Server throttles per Session and answers before the
     * refresh finishes; the usual `projectStatus.changed` and `sessionPullRequests.changed` events carry the result.
     */
    'session.refreshDeliveryOnFocus': {
        ...commandPolicy('server', 'control'),
        params: z.object({ sessionId: identifierSchema }),
        result: z.null(),
    },
} as const;

export type SessionPullRequestIcon = 'closed' | 'deployed' | 'draft' | 'merged' | 'open';
export type SessionPullRequestTone = 'danger' | 'merged' | 'neutral' | 'success' | 'warning';

/**
 * The glyph shape and color role of a Session's pull request, shared by the Desktop sidebar and the phone's Session row
 * so one pull request can never read as two different states. Lifecycle owns the color (a red open glyph was mistaken
 * for a closed one); a merged pull request becomes a rocket once production serves its merge commit, with the
 * deployment outcome moving only the color. A deployment with nothing to report falls back to the merged glyph.
 */
export function sessionPullRequestVisual(
    pullRequest: Pick<SessionPullRequest, 'deployment' | 'state'>,
): { icon: SessionPullRequestIcon; tone: SessionPullRequestTone } {
    switch (pullRequest.state) {
        case 'merged':
            switch (pullRequest.deployment?.state) {
                case 'success':
                    return { icon: 'deployed', tone: 'merged' };
                case 'failure':
                    return { icon: 'deployed', tone: 'danger' };
                case 'pending':
                case 'queued':
                    return { icon: 'deployed', tone: 'warning' };
                default:
                    return { icon: 'merged', tone: 'merged' };
            }
        case 'closed':
            return { icon: 'closed', tone: 'danger' };
        case 'draft':
            return { icon: 'draft', tone: 'neutral' };
        case 'open':
            return { icon: 'open', tone: 'success' };
    }
}

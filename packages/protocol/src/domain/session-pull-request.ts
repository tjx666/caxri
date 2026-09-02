import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './domain.js';
import { projectStatusStateSchema } from './project-status-state.js';

export const sessionPullRequestStateSchema = z.enum(['draft', 'open', 'merged', 'closed']);

/**
 * The GitHub pull request a Session is delivering, projected onto the PrimarySidebar row. `source` records how the link
 * was discovered: `agent` when the Session's primary Agent created or discussed it in its transcript, `branch` when it
 * was looked up from the Workbench root's checked-out branch.
 */
export const sessionPullRequestSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.url(),
    state: sessionPullRequestStateSchema,
    /**
     * Aggregated CI check rollup; absent when GitHub reported no checks.
     */
    checks: projectStatusStateSchema.optional(),
    source: z.enum(['agent', 'branch']),
});

export const sessionPullRequestsSchema = z.object({
    /**
     * Keyed by Session id; Sessions without a discovered pull request are omitted.
     */
    pullRequests: z.record(identifierSchema, sessionPullRequestSchema),
    refreshedAt: z.number(),
});

export type SessionPullRequest = z.infer<typeof sessionPullRequestSchema>;
export type SessionPullRequestState = z.infer<typeof sessionPullRequestStateSchema>;
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
} as const;

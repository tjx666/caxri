import { z } from 'zod';

import { hexColorSchema } from './color.js';
import { projectStatusStateSchema } from './project-status-state.js';
import {
    pullRequestUnavailableSchema,
    sessionPullRequestStateSchema,
} from './session-pull-request.js';

/**
 * Project Status wire shapes: the per-repository rollup the Status panel renders and the compact overview the Session
 * header shows. `./project-status-state.js` owns the shared check-like state enum these reuse.
 */
const projectStatusCheckSchema = z.object({
    name: z.string(),
    state: projectStatusStateSchema,
    url: z.url().optional(),
    durationMs: z.number().nonnegative().optional(),
});

const projectStatusLinearIssueSchema = z.object({
    identifier: z.string(),
    title: z.string().optional(),
    url: z.url().optional(),
    state: z.string().optional(),
    stateType: z
        .enum(['backlog', 'canceled', 'completed', 'duplicate', 'started', 'triage', 'unstarted'])
        .optional(),
    /**
     * The color this Linear workspace assigned to the workflow state. `stateType` cannot stand in for it: Linear groups
     * "In Progress", "In Review" and "Ready to Merge" under the single `started` type while letting each workspace
     * color and name them separately, so the type decides the glyph and this decides its tint.
     */
    stateColor: hexColorSchema.optional(),
});

const projectStatusDeploymentSchema = z.object({
    environment: z.enum(['production', 'preview']),
    hostname: z.string(),
    state: projectStatusStateSchema,
    url: z.url(),
    inspectorUrl: z.url().optional(),
    createdAt: z.number().optional(),
});

const projectStatusErrorSchema = z.object({
    source: z.enum(['github', 'linear', 'vercel']),
    kind: z.enum(['prerequisite', 'failure']),
    /**
     * Set for the failures that are one condition across every repository in the Project rather than a property of the
     * repository reporting them: a lost connection, and a provider budget the whole account shares. The Status panel
     * coalesces these into a single message instead of repeating them under each repository.
     */
    reason: z.enum(['network', 'rate-limited', 'tls']).optional(),
    message: z.string(),
    hint: z.string(),
    /**
     * Epoch ms when Caxri's own circuit breaker will query this provider again, from the reset GitHub reported. Present
     * only alongside `rate-limited`, and only when the limiter knows the deadline; a consumer must still compare it
     * against the current time, because a cached snapshot outlives its own pause.
     */
    retryAt: z.number().optional(),
    detailsView: z.literal('logs').optional(),
});

const projectStatusRepoSchema = z.object({
    id: z.string(),
    kind: z.enum(['primary', 'worktree', 'nested', 'submodule']),
    name: z.string(),
    rootPath: z.string(),
    branch: z.string(),
    defaultBranch: z.string().optional(),
    githubUrl: z.url().optional(),
    branchUrl: z.url().optional(),
    publication: z
        .object({
            state: z.enum([
                'checking',
                'unpublished',
                'published',
                'synced',
                'ahead',
                'behind',
                'diverged',
                'unknown',
                'no-origin',
                'unsupported',
                'detached',
                'unborn',
            ]),
            remoteBranch: z.string().optional(),
            checkedAt: z.number().optional(),
            ahead: z.number().int().nonnegative().optional(),
            behind: z.number().int().nonnegative().optional(),
        })
        .optional(),
    pullRequest: z
        .object({
            number: z.number().int().positive(),
            title: z.string(),
            url: z.url(),
            /**
             * PR lifecycle is independent of the CI rollup; absent when the provider omits it.
             */
            lifecycle: sessionPullRequestStateSchema.optional(),
            state: projectStatusStateSchema,
            checks: z.array(projectStatusCheckSchema),
            hiddenCheckCount: z.number().int().nonnegative(),
        })
        .optional(),
    linearIssues: z.array(projectStatusLinearIssueSchema),
    deployments: z
        .object({
            url: z.url(),
            branchDeployments: z.array(projectStatusDeploymentSchema),
            production: projectStatusDeploymentSchema.optional(),
            preview: projectStatusDeploymentSchema.optional(),
        })
        .optional(),
    errors: z.array(projectStatusErrorSchema),
});

export const projectStatusSummarySchema = z.object({
    repositories: z.array(projectStatusRepoSchema),
    refreshedAt: z.number(),
    error: z.string().optional(),
});

const projectStatusOverviewPullRequestSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.url(),
});

const projectStatusOverviewRepoSchema = z.object({
    id: z.string(),
    branch: z.string(),
    branchUrl: z.url().optional(),
    changedFileCount: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    pullRequest: projectStatusOverviewPullRequestSchema.optional(),
    pullRequestUnavailable: pullRequestUnavailableSchema.optional(),
});

export const projectStatusOverviewSchema = z.object({
    repository: projectStatusOverviewRepoSchema.optional(),
    refreshedAt: z.number(),
    error: z.string().optional(),
});

export type ProjectStatusState = z.infer<typeof projectStatusStateSchema>;
export type ProjectStatusCheck = z.infer<typeof projectStatusCheckSchema>;
export type ProjectStatusLinearIssue = z.infer<typeof projectStatusLinearIssueSchema>;
export type ProjectStatusDeployment = z.infer<typeof projectStatusDeploymentSchema>;
export type ProjectStatusError = z.infer<typeof projectStatusErrorSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported type is imported widely across apps/desktop and apps/server/src/domains, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type ProjectStatusRepository = z.infer<typeof projectStatusRepoSchema>;
export type ProjectStatusSummary = z.infer<typeof projectStatusSummarySchema>;
export type ProjectStatusOverview = z.infer<typeof projectStatusOverviewSchema>;

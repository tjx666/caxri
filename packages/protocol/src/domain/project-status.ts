import { z } from 'zod';

import { hexColorSchema } from './color.js';
import { logLevelSchema } from './log-level.js';
import { projectStatusStateSchema, pullRequestMergeStateSchema } from './project-status-state.js';
import {
    pullRequestUnavailableSchema,
    sessionPullRequestStateSchema,
} from './session-pull-request.js';

export { pullRequestMergeStateSchema } from './project-status-state.js';

/**
 * Project Status wire shapes: the per-repository rollup the Status panel renders and the compact overview the Session
 * header shows. `./project-status-state.js` owns the shared check-like state enum these reuse.
 */
const projectStatusCheckSchema = z.object({
    name: z.string(),
    state: projectStatusStateSchema,
    url: z.url().optional(),
    durationMs: z.number().nonnegative().optional(),
    /**
     * When the check settled, in epoch milliseconds. Lets the delivery-failure alert tell a failure that happened while
     * Caxri was watching from one that predates it.
     */
    completedAt: z.number().optional(),
});

/**
 * One unresolved, current review thread on a pull request, represented by its opening comment. A thread GitHub marks
 * outdated is left out: its anchor line no longer exists in the diff, so it is rarely the next thing to act on.
 */
const projectStatusReviewThreadSchema = z.object({
    url: z.url(),
    body: z.string(),
    author: z.string().optional(),
    /**
     * Epoch milliseconds of the opening comment.
     */
    createdAt: z.number().optional(),
    path: z.string().optional(),
    line: z.number().int().positive().optional(),
});

export const projectStatusLinearIssueSchema = z.object({
    identifier: z.string(),
    title: z.string().optional(),
    /**
     * The description's opening as plain text, capped at the Server, for a link's hover card.
     */
    excerpt: z.string().optional(),
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

/**
 * Where an acceptance report sits in its own lifecycle. Distinct from {@link acceptanceVerdictSchema}: a report can be
 * `repairing` after a round already returned `failed`, and `accepted` is a person's decision rather than a run's
 * result.
 */
const acceptanceStatusSchema = z.enum([
    'pending',
    'planned',
    'verifying',
    'repairing',
    'delivered',
    'accepted',
    'closed',
    'rejected',
    'errored',
]);

/**
 * What one verification round concluded. `uncertain` is a real third outcome, not a missing value: a round that could
 * not decide is explicitly different from one that has not finished.
 */
const acceptanceVerdictSchema = z.enum(['passed', 'failed', 'uncertain']);

/**
 * One acceptance report a branch is delivering against. Everything past `id` is absent until the report resolves, so a
 * link Caxri recognized but could not read still renders as itself.
 */
const projectStatusAcceptanceSchema = z.object({
    id: z.string(),
    /**
     * The report reduced to the same state vocabulary a check or a deployment reports, computed by the Server so the
     * status bar and the Status panel cannot reach different conclusions about one report. See
     * {@link acceptanceProjectStatusState} for the rule.
     */
    state: projectStatusStateSchema,
    url: z.url().optional(),
    /**
     * The 1-based round the link pinned, when it named one. Absent means the link pointed at the report as a whole, and
     * the latest round is the one that answers for it.
     */
    round: z.number().int().positive().optional(),
    title: z.string().optional(),
    status: acceptanceStatusSchema.optional(),
    verdict: acceptanceVerdictSchema.optional(),
    passedChecks: z.number().int().nonnegative().optional(),
    totalChecks: z.number().int().nonnegative().optional(),
    roundCount: z.number().int().nonnegative().optional(),
});

/**
 * The Git commit a provider built, when the deployment came from a connected repository rather than a direct CLI
 * upload. It identifies the deployment far better than the generated alias does, so the Status panel leads with it.
 */
const projectStatusDeploymentCommitSchema = z.object({
    sha: z.string(),
    /**
     * Subject line only. Provider metadata carries the full message, and a body turns a one-line row into a paragraph.
     */
    message: z.string().optional(),
    authorLogin: z.string().optional(),
    url: z.url().optional(),
});

const projectStatusDeploymentSchema = z.object({
    environment: z.enum(['production', 'preview']),
    hostname: z.string(),
    state: projectStatusStateSchema,
    url: z.url(),
    inspectorUrl: z.url().optional(),
    createdAt: z.number().optional(),
    commit: projectStatusDeploymentCommitSchema.optional(),
});

/**
 * Where in the log viewer this failure left its record, for an error whose real explanation is only in the logs.
 *
 * Carrying the query rather than a bare "the details are in the logs" flag is what makes the offer usable: the panel it
 * opened held every process's records at every level, so the one line that explained the failure was somewhere in
 * thousands, and the user had to guess both the search term and which levels to leave on. It is also a forcing function
 * on the producer, a provider cannot claim its details are in the logs without naming the event it wrote.
 */
const projectStatusErrorLogsSchema = z.object({
    /**
     * Passed to the viewer's text filter verbatim, so it obeys the same grammar the user types: OR on commas, `!`
     * excludes.
     */
    filter: z.string().min(1),
    /**
     * The levels left on. Narrow it to the levels the named event is actually written at; everything else is noise.
     */
    levels: z.array(logLevelSchema).min(1),
});

const projectStatusErrorSchema = z.object({
    source: z.enum(['acceptance', 'github', 'linear', 'vercel']),
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
    logs: projectStatusErrorLogsSchema.optional(),
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
            /**
             * The head commit GitHub reports, which a merge is pinned to so a later push cannot ride along unseen.
             */
            headSha: z
                .string()
                .regex(/^[0-9a-f]{40}$/)
                .optional(),
            /**
             * The branch the pull request was opened from. It differs from the row's checked-out branch when the
             * Session's own Agent delivered the pull request from another worktree.
             */
            headBranch: z.string().min(1).optional(),
            /**
             * Absent when the provider omitted the mergeability fields.
             */
            mergeState: pullRequestMergeStateSchema.optional(),
            /**
             * Absent when the threads were not read (the pull request is no longer open, or the read failed) so a
             * consumer never mistakes "unknown" for "nothing left to address".
             */
            unresolvedReviewThreads: z.array(projectStatusReviewThreadSchema).optional(),
        })
        .optional(),
    linearIssues: z.array(projectStatusLinearIssueSchema),
    acceptances: z.array(projectStatusAcceptanceSchema),
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

/**
 * How the status bar found its pull request: `conversation` when the Session's own Agent opened or named it, `branch`
 * when it was looked up from the checked-out branch.
 */
export const pullRequestSourceSchema = z.enum(['conversation', 'branch']);

const projectStatusOverviewPullRequestSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.url(),
    /**
     * The branch the pull request was opened from; absent when the provider omitted it.
     */
    headBranch: z.string().min(1).optional(),
    source: pullRequestSourceSchema,
});

/**
 * Where Caxri learned that this branch is about this issue, in descending order of how deliberate the statement was.
 * The status bar names it, because "the pull request says so" and "somebody typed it in the chat" deserve different
 * amounts of trust from the person reading the chip.
 */
export const linearIssueSourceSchema = z.enum(['pull-request', 'branch', 'conversation']);

const projectStatusOverviewLinearIssueSchema = projectStatusLinearIssueSchema.extend({
    source: linearIssueSourceSchema,
});

/**
 * Same question as {@link linearIssueSourceSchema}, minus `branch`: an acceptance report is addressed by an opaque id,
 * which a branch name has no room to carry and no reason to.
 */
export const acceptanceSourceSchema = z.enum(['pull-request', 'conversation']);

const projectStatusOverviewAcceptanceSchema = projectStatusAcceptanceSchema.extend({
    source: acceptanceSourceSchema,
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
    /**
     * Ordered most authoritative first. Only the leading entry carries a resolved title and workflow state: the status
     * bar shows one issue and counts the rest, so resolving the tail would spend a query per refresh on text nothing
     * renders.
     */
    linearIssues: z.array(projectStatusOverviewLinearIssueSchema),
    /**
     * Ordered most authoritative first, and resolved on the same "lead only" rule as `linearIssues`.
     */
    acceptances: z.array(projectStatusOverviewAcceptanceSchema),
});

export const projectStatusOverviewSchema = z.object({
    repository: projectStatusOverviewRepoSchema.optional(),
    refreshedAt: z.number(),
    error: z.string().optional(),
});

export type ProjectStatusState = z.infer<typeof projectStatusStateSchema>;

/**
 * Reduces an acceptance report to the same state vocabulary a check or a deployment reports. The Server calls it once
 * and ships the answer as `state`, so the status bar and the Status panel render the same verdict instead of each
 * quantizing the lifecycle and the round result for itself.
 *
 * The verdict wins over the lifecycle when both are present, because it is the newer fact: a report sitting in
 * `repairing` after a round returned `failed` is failing right now, whatever happens next. `uncertain` maps to
 * `pending` rather than `neutral`, a round that could not decide still wants a human, and `neutral` reads as settled.
 */
export function acceptanceProjectStatusState(
    acceptance: Pick<ProjectStatusAcceptance, 'status' | 'verdict'>,
): ProjectStatusState {
    if (acceptance.verdict === 'failed') return 'failure';
    if (acceptance.verdict === 'uncertain') return 'pending';
    if (acceptance.verdict === 'passed' && !acceptance.status) return 'success';
    switch (acceptance.status) {
        case 'accepted': {
            return 'success';
        }
        case 'errored':
        case 'rejected': {
            return 'failure';
        }
        case 'closed': {
            return 'cancelled';
        }
        case 'delivered':
        case 'repairing':
        case 'verifying': {
            return 'pending';
        }
        case 'pending':
        case 'planned': {
            return 'neutral';
        }
        default: {
            // A resolved report whose round passed but whose lifecycle Caxri does not recognize is still good news.
            return acceptance.verdict === 'passed' ? 'success' : 'unknown';
        }
    }
}
export type ProjectStatusCheck = z.infer<typeof projectStatusCheckSchema>;
export type PullRequestMergeState = z.infer<typeof pullRequestMergeStateSchema>;
export type ProjectStatusLinearIssue = z.infer<typeof projectStatusLinearIssueSchema>;
export type ProjectStatusReviewThread = z.infer<typeof projectStatusReviewThreadSchema>;
export type LinearIssueSource = z.infer<typeof linearIssueSourceSchema>;
export type PullRequestSource = z.infer<typeof pullRequestSourceSchema>;
export type ProjectStatusOverviewLinearIssue = z.infer<
    typeof projectStatusOverviewLinearIssueSchema
>;
export type ProjectStatusAcceptance = z.infer<typeof projectStatusAcceptanceSchema>;
export type AcceptanceStatus = z.infer<typeof acceptanceStatusSchema>;
export type AcceptanceVerdict = z.infer<typeof acceptanceVerdictSchema>;
export type AcceptanceSource = z.infer<typeof acceptanceSourceSchema>;
export type ProjectStatusOverviewAcceptance = z.infer<typeof projectStatusOverviewAcceptanceSchema>;
export type ProjectStatusDeployment = z.infer<typeof projectStatusDeploymentSchema>;
export type ProjectStatusDeploymentCommit = z.infer<typeof projectStatusDeploymentCommitSchema>;
export type ProjectStatusError = z.infer<typeof projectStatusErrorSchema>;
/**
 * Exported as a schema, not only a type: the Status extension hands this to a tree item's `command.arguments`, which
 * the view contract types as `unknown[]`, so the Renderer has to re-validate it rather than assert the shape.
 */
export { projectStatusErrorLogsSchema };
export type ProjectStatusErrorLogs = z.infer<typeof projectStatusErrorLogsSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported type is imported widely across apps/desktop and apps/server/src/domains, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type ProjectStatusRepository = z.infer<typeof projectStatusRepoSchema>;
export type ProjectStatusSummary = z.infer<typeof projectStatusSummarySchema>;
export type ProjectStatusOverview = z.infer<typeof projectStatusOverviewSchema>;

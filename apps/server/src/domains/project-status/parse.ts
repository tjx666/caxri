import type {
    AcceptanceStatus,
    AcceptanceVerdict,
    ProjectStatusAcceptance,
    ProjectStatusCheck,
    ProjectStatusLinearIssue,
    ProjectStatusRepository as ProjectStatusRepo,
    ProjectStatusState,
    SessionPullRequestState,
} from '@caxri/protocol';
import {
    acceptanceProjectStatusState,
    CaxriError,
    hexColorSchema,
    isIgnoredCheck,
} from '@caxri/protocol';
import { z } from 'zod';

import { acceptanceUrl } from '../acceptance-link';

/**
 * Wire shapes and projections for the three external CLIs Project Status reads. Kept beside `./index.ts` rather than
 * inside it so the service file stays about orchestration — cache lifetime, refresh generations, and the resident poll
 * — and this file stays about turning `gh`, `linear`, and `vc` output into protocol types.
 */

const githubCheckSchema = z.object({
    __typename: z.string().optional(),
    completedAt: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    context: z.string().optional(),
    detailsUrl: z.string().optional(),
    name: z.string().optional(),
    startedAt: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    targetUrl: z.string().optional(),
    workflowName: z.string().optional(),
});

type GitHubCheck = z.infer<typeof githubCheckSchema>;

export const githubPullRequestSchema = z.object({
    body: z.string().optional(),
    isDraft: z.boolean().optional(),
    mergeCommit: z.object({ oid: z.string() }).nullish(),
    state: z.string().optional(),
    number: z.number().int().positive().optional(),
    statusCheckRollup: z.array(githubCheckSchema).optional(),
    title: z.string().min(1).optional(),
    url: z.string().optional(),
});

/**
 * Git provenance Vercel copies onto a deployment built from a connected repository. A direct CLI upload carries none of
 * it, so every field stays optional and the deployment row falls back to its alias.
 *
 * @see https://vercel.com/docs/deployments/environments#system-environment-variables
 */
const vercelDeploymentMetaSchema = z.object({
    githubCommitAuthorLogin: z.string().optional(),
    githubCommitMessage: z.string().optional(),
    githubCommitOrg: z.string().optional(),
    githubCommitRepo: z.string().optional(),
    githubCommitSha: z.string().optional(),
});

const vercelDeploymentSchema = z.object({
    uid: z.string().optional(),
    created: z.number().optional(),
    inspectorUrl: z.string().nullable().optional(),
    meta: vercelDeploymentMetaSchema.optional(),
    name: z.string().optional(),
    readyState: z.string().optional(),
    state: z.string().optional(),
    target: z.enum(['production', 'preview', 'staging']).nullable().optional(),
    url: z.string().nullable().optional(),
});

export type VercelDeployment = z.infer<typeof vercelDeploymentSchema>;

const vercelDeploymentListSchema = z.union([
    z.array(vercelDeploymentSchema),
    z.object({ deployments: z.array(vercelDeploymentSchema).optional() }),
]);

const vercelTeamSchema = z.object({ slug: z.string().optional() });

export const vercelTeamListSchema = z.union([
    z.array(vercelTeamSchema),
    z.object({ teams: z.array(vercelTeamSchema).optional() }),
]);

const linearIssueStateSchema = z.object({
    name: z.string().optional(),
    type: z.string().optional(),
    color: z.string().optional(),
});

const linearIssueSchema = z.object({
    identifier: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    state: linearIssueStateSchema.optional(),
});

export const linearIssueResponseSchema = z.object({
    data: z.object({ issue: linearIssueSchema.optional() }).optional(),
});

export const LINEAR_ISSUE_QUERY = `query IssueStatus($id:String!){
  issue(id:$id){identifier title url state{name type color}}
}`;

const LINEAR_STATE_TYPES = new Set<ProjectStatusLinearIssue['stateType']>([
    'backlog',
    'canceled',
    'completed',
    'duplicate',
    'started',
    'triage',
    'unstarted',
]);

function linearStateType(value: string | undefined): ProjectStatusLinearIssue['stateType'] {
    return LINEAR_STATE_TYPES.has(value as ProjectStatusLinearIssue['stateType'])
        ? (value as ProjectStatusLinearIssue['stateType'])
        : undefined;
}

/**
 * Drops a workflow color Caxri cannot safely render instead of failing the issue: the state's name, type and link are
 * the load-bearing parts of the row, and the icon falls back to the row's theme color without its tint.
 */
export function linearStateColor(value: string | undefined): string | undefined {
    const parsed = hexColorSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
}

/**
 * Projects one Linear GraphQL response onto the wire shape. `fallbackIdentifier` keeps the row addressable when the
 * response omits the issue, which is what a permission-scoped workspace returns for an issue the token cannot read.
 */
export function mapLinearIssue(
    response: z.infer<typeof linearIssueResponseSchema>,
    fallbackIdentifier: string,
): ProjectStatusLinearIssue {
    const issue = response.data?.issue;
    return {
        identifier: issue?.identifier ?? fallbackIdentifier,
        title: issue?.title,
        url: issue?.url,
        state: issue?.state?.name,
        stateType: linearStateType(issue?.state?.type),
        stateColor: linearStateColor(issue?.state?.color),
    };
}

const acceptanceReportSchema = z.object({
    passedChecks: z.number().nullish(),
    totalChecks: z.number().nullish(),
    verdict: z.string().nullish(),
});

/**
 * Only the fields the two Caxri surfaces draw. The bundle also carries every check, every review, and a usage ledger;
 * `--json acceptance,subject,latestReport,rounds` already leaves those behind, and this schema is the second guard.
 */
const acceptanceRoundSchema = z.object({
    report: acceptanceReportSchema.nullish(),
    run: z.object({ roundIndex: z.number().nullish() }).nullish(),
});

export const acceptanceBundleSchema = z.object({
    acceptance: z.object({ status: z.string().nullish() }).nullish(),
    latestReport: acceptanceReportSchema.nullish(),
    rounds: z.array(acceptanceRoundSchema).nullish(),
    subject: z.object({ title: z.string().nullish() }).nullish(),
});

const ACCEPTANCE_STATUSES = new Set<AcceptanceStatus>([
    'accepted',
    'closed',
    'delivered',
    'errored',
    'pending',
    'planned',
    'rejected',
    'repairing',
    'verifying',
]);
const ACCEPTANCE_VERDICTS = new Set<AcceptanceVerdict>(['failed', 'passed', 'uncertain']);

/**
 * Projects one acceptance bundle onto the wire shape, answering for the round the link pinned rather than for the
 * report as a whole. A link that named round 2 must keep reporting round 2 after round 3 runs: that is what makes a
 * pasted link a stable reference instead of a moving one. Without a pinned round the latest report answers.
 */
export function mapAcceptanceBundle(
    bundle: z.infer<typeof acceptanceBundleSchema>,
    reference: { id: string; round?: number },
): ProjectStatusAcceptance {
    const rounds = bundle.rounds ?? [];
    const pinned = reference.round
        ? rounds.find((round) => round.run?.roundIndex === reference.round)
        : undefined;
    const report = pinned?.report ?? bundle.latestReport;
    const rawStatus = bundle.acceptance?.status ?? undefined;
    const rawVerdict = report?.verdict ?? undefined;
    // Provider strings are narrowed here rather than in the schema so an enum value Caxri has not seen yet leaves the
    // field absent instead of rejecting the whole bundle and blanking a report the user can otherwise read.
    const status = ACCEPTANCE_STATUSES.has(rawStatus as AcceptanceStatus)
        ? (rawStatus as AcceptanceStatus)
        : undefined;
    const verdict = ACCEPTANCE_VERDICTS.has(rawVerdict as AcceptanceVerdict)
        ? (rawVerdict as AcceptanceVerdict)
        : undefined;
    return {
        id: reference.id,
        state: acceptanceProjectStatusState({ status, verdict }),
        url: acceptanceUrl(reference.id, reference.round),
        ...(reference.round && { round: reference.round }),
        ...(bundle.subject?.title && { title: bundle.subject.title }),
        ...(status && { status }),
        ...(verdict && { verdict }),
        ...(typeof report?.passedChecks === 'number' && { passedChecks: report.passedChecks }),
        ...(typeof report?.totalChecks === 'number' && { totalChecks: report.totalChecks }),
        ...(rounds.length > 0 && { roundCount: rounds.length }),
    };
}

const SUCCESS_RESULTS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'COMPLETED']);
const FAILURE_RESULTS = new Set([
    'FAILURE',
    'FAILED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'ERROR',
]);
/**
 * Actually executing. GitHub reports this as a `status`, never as a `conclusion`.
 */
const RUNNING_RESULTS = new Set(['IN_PROGRESS']);
/**
 * Accepted but not started. `PENDING` and `EXPECTED` are the commit-status API's equivalents of a queued check run: a
 * context that has been registered and has reported no result yet.
 */
const QUEUED_RESULTS = new Set(['QUEUED', 'WAITING', 'REQUESTED', 'PENDING', 'EXPECTED']);

export function parseExternalJson<T>(value: string, schema: z.ZodType<T>, label: string): T {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new CaxriError('VALIDATION', `Invalid ${label} JSON`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new CaxriError('VALIDATION', `Invalid ${label} payload`);
    return result.data;
}

function checkState(check: GitHubCheck): ProjectStatusState {
    const status = (check.status ?? '').toUpperCase();
    const result = (check.conclusion ?? check.state ?? '').toUpperCase();
    if (RUNNING_RESULTS.has(status) || RUNNING_RESULTS.has(result)) return 'pending';
    if (QUEUED_RESULTS.has(status) || QUEUED_RESULTS.has(result)) return 'queued';
    if (FAILURE_RESULTS.has(result)) return 'failure';
    if (result === 'CANCELLED') return 'cancelled';
    if (SUCCESS_RESULTS.has(result)) return 'success';
    return 'neutral';
}

function aggregateChecks(checks: ProjectStatusCheck[]): ProjectStatusState {
    if (checks.some((check) => check.state === 'failure')) return 'failure';
    if (checks.length === 0 || checks.some((check) => check.state === 'pending')) return 'pending';
    // Nothing is running yet, but the run is not over either. Rolled up as `queued` rather than `pending` so the
    // summary can say a run has not started, which is the difference between waiting on a runner and waiting on CI.
    if (checks.some((check) => check.state === 'queued')) return 'queued';
    /**
     * Cancellation is visible but non-blocking once another terminal check supplies the rollup outcome. Preserve it as
     * the parent state only when cancellation is the sole outcome, because that set did not prove any work passed.
     */
    if (checks.every((check) => check.state === 'cancelled')) return 'cancelled';
    return 'success';
}

function checkDuration(check: GitHubCheck): number | undefined {
    if (!check.startedAt || !check.completedAt) return undefined;
    const duration = Date.parse(check.completedAt) - Date.parse(check.startedAt);
    return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function checkCompletedAt(check: GitHubCheck): number | undefined {
    if (!check.completedAt) return undefined;
    const completedAt = Date.parse(check.completedAt);
    // GitHub reports `0001-01-01T00:00:00Z` for a check that has not completed yet.
    return Number.isFinite(completedAt) && completedAt > 0 ? completedAt : undefined;
}

function projectCheck(check: GitHubCheck): ProjectStatusCheck {
    return {
        name: check.workflowName
            ? `${check.workflowName} / ${check.name ?? check.context ?? '?'}`
            : (check.name ?? check.context ?? '?'),
        state: checkState(check),
        url: check.detailsUrl ?? check.targetUrl,
        durationMs: checkDuration(check),
        completedAt: checkCompletedAt(check),
    };
}

/**
 * Reading order for one pull request's checks: what went wrong first, then what is still moving, then what is settled.
 * A state missing from this list sorts to `-1` and jumps ahead of the failures, so every member of
 * `projectStatusStateSchema` has to appear here — including `unknown`, which is what an unrecognized provider result
 * becomes.
 */
const CHECK_ORDER: ProjectStatusState[] = [
    'failure',
    'pending',
    'queued',
    'cancelled',
    'success',
    'neutral',
    'unknown',
];

/**
 * Both PR surfaces use the same lifecycle projection; a closed draft is closed, not draft.
 */
function pullRequestLifecycle(
    state: string | undefined,
    isDraft: boolean | undefined,
): SessionPullRequestState | undefined {
    switch (state?.toUpperCase()) {
        case 'MERGED':
            return 'merged';
        case 'CLOSED':
            return 'closed';
        case 'OPEN':
            return isDraft ? 'draft' : 'open';
        default:
            return undefined;
    }
}

/**
 * Projects one `gh pr view` payload. `ignoredChecks` is applied here rather than at each consumer so the Status panel's
 * rollup, the PrimarySidebar's CI badge, and the delivery-failure alert can never disagree about whether a pull request
 * is failing: they all read this one filtered result.
 */
export function parseGitHubPullRequest(
    value: string,
    ignoredChecks: readonly string[] = [],
): {
    body: string;
    pullRequest?: ProjectStatusRepo['pullRequest'];
    mergeCommit?: string;
} {
    const raw = parseExternalJson(value, githubPullRequestSchema, 'GitHub pull request');
    if (!raw.number || !raw.title || !raw.url) return { body: raw.body ?? '' };
    const rollup = raw.statusCheckRollup ?? [];
    const visible = rollup.filter(
        (check) => !isIgnoredCheck([check.name, check.context, check.workflowName], ignoredChecks),
    );
    const checks = visible.map((check) => projectCheck(check));
    checks.sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state));
    return {
        body: raw.body ?? '',
        mergeCommit:
            raw.state?.toUpperCase() === 'MERGED' &&
            /^[\da-f]{40}$/i.test(raw.mergeCommit?.oid ?? '')
                ? raw.mergeCommit?.oid
                : undefined,
        pullRequest: {
            number: raw.number,
            title: raw.title,
            url: raw.url,
            lifecycle: pullRequestLifecycle(raw.state, raw.isDraft),
            /**
             * An empty rollup means GitHub has not reported a check yet, which is genuinely pending. A rollup that is
             * empty only _after_ filtering means the user ignored every check this pull request has — reporting that as
             * a permanent spinner would be wrong, so it settles as neutral instead.
             */
            state: checks.length === 0 && rollup.length > 0 ? 'neutral' : aggregateChecks(checks),
            checks,
            hiddenCheckCount: rollup.length - visible.length,
        },
    };
}

export function parseVercelList(value: string): VercelDeployment[] {
    const parsed = parseExternalJson(value, vercelDeploymentListSchema, 'Vercel deployment list');
    const deployments = Array.isArray(parsed) ? parsed : (parsed.deployments ?? []);
    return deployments.toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

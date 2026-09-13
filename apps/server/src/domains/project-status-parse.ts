import type {
    ProjectStatusCheck,
    ProjectStatusLinearIssue,
    ProjectStatusRepository as ProjectStatusRepo,
    ProjectStatusState,
    SessionPullRequestState,
} from '@caxri/protocol';
import { CaxriError, hexColorSchema, isIgnoredCheck } from '@caxri/protocol';
import { z } from 'zod';

/**
 * Wire shapes and projections for the three external CLIs Project Status reads. Kept beside `./project-status.ts`
 * rather than inside it so the service file stays about orchestration — cache lifetime, refresh generations, and the
 * resident poll — and this file stays about turning `gh`, `linear`, and `vc` output into protocol types.
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
    state: z.string().optional(),
    number: z.number().int().positive().optional(),
    statusCheckRollup: z.array(githubCheckSchema).optional(),
    title: z.string().min(1).optional(),
    url: z.string().optional(),
});

const vercelDeploymentSchema = z.object({
    uid: z.string().optional(),
    created: z.number().optional(),
    inspectorUrl: z.string().nullable().optional(),
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

const SUCCESS_RESULTS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'COMPLETED']);
const FAILURE_RESULTS = new Set([
    'FAILURE',
    'FAILED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'ERROR',
]);
const PENDING_RESULTS = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'EXPECTED']);

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
    if (PENDING_RESULTS.has(status) || PENDING_RESULTS.has(result)) return 'pending';
    if (FAILURE_RESULTS.has(result)) return 'failure';
    if (result === 'CANCELLED') return 'cancelled';
    if (SUCCESS_RESULTS.has(result)) return 'success';
    return 'neutral';
}

function aggregateChecks(checks: ProjectStatusCheck[]): ProjectStatusState {
    if (checks.some((check) => check.state === 'failure')) return 'failure';
    if (checks.length === 0 || checks.some((check) => check.state === 'pending')) return 'pending';
    /**
     * A cancelled check did not pass; preserve that outcome without raising a failure alert.
     */
    if (checks.some((check) => check.state === 'cancelled')) return 'cancelled';
    return 'success';
}

function checkDuration(check: GitHubCheck): number | undefined {
    if (!check.startedAt || !check.completedAt) return undefined;
    const duration = Date.parse(check.completedAt) - Date.parse(check.startedAt);
    return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function projectCheck(check: GitHubCheck): ProjectStatusCheck {
    return {
        name: check.workflowName
            ? `${check.workflowName} / ${check.name ?? check.context ?? '?'}`
            : (check.name ?? check.context ?? '?'),
        state: checkState(check),
        url: check.detailsUrl ?? check.targetUrl,
        durationMs: checkDuration(check),
    };
}

const CHECK_ORDER: ProjectStatusState[] = ['failure', 'pending', 'cancelled', 'success', 'neutral'];

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

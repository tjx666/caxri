import type {
    AcceptanceStatus,
    AcceptanceVerdict,
    ProjectStatusAcceptance,
    ProjectStatusLinearIssue,
} from '@caxri/protocol';
import { acceptanceProjectStatusState, CaxriError, hexColorSchema } from '@caxri/protocol';
import { z } from 'zod';

import { acceptanceUrl } from '../acceptance-link';

/**
 * Wire shapes and projections for the two on-demand CLIs this domain resolves: `linear` and `lh acceptance`. Kept
 * beside `./linear.ts` and `./acceptance.ts` rather than inside them so those files stay about the store's own concern
 * — cache lifetime and single-flight coalescing — and this file stays about turning raw CLI output into protocol types.
 * `project-status/parse.ts` holds the equivalent modules for `gh` and `vc`, which stay outside this domain because
 * reading and displaying a pull request or a deployment is a Project Status concern, not an external-status one.
 */

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

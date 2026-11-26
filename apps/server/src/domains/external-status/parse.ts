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
 * (cache lifetime and single-flight coalescing) and this file stays about turning raw CLI output into protocol types.
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
    description: z.string().nullish(),
    url: z.string().optional(),
    state: linearIssueStateSchema.optional(),
});

export const linearIssueResponseSchema = z.object({
    data: z.object({ issue: linearIssueSchema.optional() }).optional(),
});

export const LINEAR_ISSUE_QUERY = `query IssueStatus($id:String!){
  issue(id:$id){identifier title description url state{name type color}}
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
/**
 * Long enough to fill the hover card's three clamped lines; the rest of a long description never crosses the wire.
 */
const MAX_DESCRIPTION_EXCERPT_LENGTH = 280;
/**
 * Only the opening can reach the excerpt, and the link patterns below scan to the end of the input for every unmatched
 * `[`, so a long pasted log would otherwise cost the Server seconds on every refresh of every issue that carries it.
 */
const MAX_DESCRIPTION_SCAN_LENGTH = 4_096;

/**
 * The opening of an issue's Markdown description as plain prose for a preview. Linear stores Markdown with escaped
 * punctuation (`\##`, ```), so escapes are undone before headings, emphasis, code ticks, images, and link targets are
 * dropped; whitespace collapses so line breaks do not leave gaps in a clamped paragraph.
 */
export function linearDescriptionExcerpt(markdown: string | null | undefined): string | undefined {
    if (!markdown) return undefined;
    const text = markdown
        .slice(0, MAX_DESCRIPTION_SCAN_LENGTH)
        .replaceAll(/\\([\\`*_{}[\]()#+\-.!<>~|])/gu, '$1')
        .replaceAll(/!\[[^\]]*\]\([^)]*\)/gu, '')
        .replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replaceAll(/^\s{0,3}```\S*\s*$/gmu, '')
        .replaceAll(/^\s{0,3}(?:#{1,6}|[>\-*+]|\d+\.)\s+/gmu, '')
        .replaceAll(/\*\*|__|~~|`/gu, '')
        .replaceAll(/(^|[^\p{L}\p{N}])[*_]([^*_\n]+)[*_](?![\p{L}\p{N}])/gmu, '$1$2')
        .replaceAll(/\s+/gu, ' ')
        .trim();
    if (!text) return undefined;
    return text.length > MAX_DESCRIPTION_EXCERPT_LENGTH
        ? `${text.slice(0, MAX_DESCRIPTION_EXCERPT_LENGTH).trimEnd()}…`
        : text;
}

export function mapLinearIssue(
    response: z.infer<typeof linearIssueResponseSchema>,
    fallbackIdentifier: string,
): ProjectStatusLinearIssue {
    const issue = response.data?.issue;
    return {
        identifier: issue?.identifier ?? fallbackIdentifier,
        title: issue?.title,
        excerpt: linearDescriptionExcerpt(issue?.description),
        url: issue?.url,
        state: issue?.state?.name,
        stateType: linearStateType(issue?.state?.type),
        stateColor: linearStateColor(issue?.state?.color),
    };
}

const acceptanceReportSchema = z.object({
    failedChecks: z.number().nullish(),
    passedChecks: z.number().nullish(),
    totalChecks: z.number().nullish(),
    uncertainChecks: z.number().nullish(),
    verdict: z.string().nullish(),
});

/**
 * The report's pass count, filled in when the provider left it out. A round that re-verifies only some checks is
 * published with `totalChecks` and a `passed` verdict but no per-outcome counts, and without this the tally vanished
 * from both surfaces exactly when a round fully passed. A `passed` verdict with no failed or uncertain check can only
 * mean every check passed; any other gap stays a gap rather than a guess.
 */
function acceptancePassedChecks(
    report: z.infer<typeof acceptanceReportSchema> | null | undefined,
): number | undefined {
    if (typeof report?.passedChecks === 'number') return report.passedChecks;
    if (
        report?.verdict === 'passed' &&
        typeof report.totalChecks === 'number' &&
        !(report.failedChecks ?? 0) &&
        !(report.uncertainChecks ?? 0)
    )
        return report.totalChecks;
    return undefined;
}

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
 * The newest round's index, which is the viewer's `turn` value. Falls back to the round count for a bundle whose runs
 * carry no index, and is `undefined` for a report that has not run a round yet.
 */
function latestRoundIndex(
    rounds: ReadonlyArray<z.infer<typeof acceptanceRoundSchema>>,
): number | undefined {
    const indexes = rounds.flatMap((round) => round.run?.roundIndex ?? []);
    const latest = indexes.length > 0 ? Math.max(...indexes) : rounds.length;
    return latest > 0 ? latest : undefined;
}

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
    const passedChecks = acceptancePassedChecks(report);
    return {
        id: reference.id,
        state: acceptanceProjectStatusState({ status, verdict }),
        // An unpinned link opens the round whose tally it shows. Without `turn` the viewer lands on its own default
        // round, so a chip reading "Round 3" opened a page that was not round 3.
        url: acceptanceUrl(reference.id, reference.round ?? latestRoundIndex(rounds)),
        ...(reference.round && { round: reference.round }),
        ...(bundle.subject?.title && { title: bundle.subject.title }),
        ...(status && { status }),
        ...(verdict && { verdict }),
        ...(passedChecks !== undefined && { passedChecks }),
        ...(typeof report?.totalChecks === 'number' && { totalChecks: report.totalChecks }),
        ...(rounds.length > 0 && { roundCount: rounds.length }),
    };
}

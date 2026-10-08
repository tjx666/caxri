import type {
    AcceptanceStatus,
    AcceptanceVerdict,
    ProjectStatusAcceptance,
    ProjectStatusDeployment,
    ProjectStatusRepository,
    ProjectStatusReviewThread,
    ProjectStatusState,
} from 'caxri';

type ProjectStatusPublication = NonNullable<ProjectStatusRepository['publication']>;

/**
 * Lifecycle wording, spelled out rather than title-cased from the enum. `delivered` and `accepted` differ by who acted
 * (the Agent finished, a person agreed), and that distinction is the whole reason a reviewer opens this row.
 *
 * Kept byte-identical to `STATUS_LABELS` in the Desktop status bar's `acceptance-label` module, together with
 * {@link acceptanceVerdictLabels} and its counterpart there. The two cannot share a module: the architecture boundary
 * forbids Desktop importing `extension-api`, and `extension-api` imports nothing, so the copies are the contract:
 * change one and this row and the status bar chip name the same report two different things, with nothing failing.
 */
const acceptanceStatusLabels: Record<AcceptanceStatus, string> = {
    pending: 'Not started',
    planned: 'Plan ready',
    verifying: 'Verifying',
    repairing: 'Repairing',
    delivered: 'Awaiting review',
    accepted: 'Accepted',
    closed: 'Closed',
    rejected: 'Rejected',
    errored: 'Errored',
};

const acceptanceVerdictLabels: Record<AcceptanceVerdict, string> = {
    passed: 'Checks passed',
    failed: 'Checks failed',
    uncertain: 'Checks inconclusive',
};

export function acceptanceStatusLabel(status: AcceptanceStatus): string {
    return acceptanceStatusLabels[status];
}

export function acceptanceVerdictLabel(verdict: AcceptanceVerdict): string {
    return acceptanceVerdictLabels[verdict];
}

/**
 * The row's own text. The subject is what a person recognizes; the opaque id never appears, because it identifies a
 * private acceptance record and tells a reader nothing it could not get from the link itself.
 */
export function acceptanceRowLabel(acceptance: ProjectStatusAcceptance): string {
    return acceptance.title ?? 'Acceptance report';
}

/**
 * The row's trailing description: the check tally, then the round as `r3`. Unlike the Linear row's state, neither is
 * carried by the glyph, so this is the only place the panel can state how much of the verification actually passed. The
 * round is abbreviated because it sits beside the tally in a narrow rail, where `round 3` or `latest of 3` spent width
 * on words; the hover card spells it out.
 *
 * An unpinned link on a multi-round report shows its newest round, and a single-round one shows none. `spoken` keeps
 * the words for the accessible name, where `r3` would be read out as a letter and a number, and says `latest of 3` for
 * an unpinned link because the round that answered may change under the same link.
 *
 * A report whose lookup failed takes the tally's place with `unknown`. It has no numbers to show, and a row that showed
 * nothing at all read as a report with nothing to say rather than as one nobody could read.
 */
export function acceptanceDescription(
    acceptance: ProjectStatusAcceptance,
    form: 'compact' | 'spoken' = 'compact',
): string | undefined {
    const tally =
        acceptance.state === 'unknown'
            ? projectStatusStateLabel('unknown')
            : acceptance.totalChecks === undefined || acceptance.passedChecks === undefined
              ? undefined
              : `${acceptance.passedChecks}/${acceptance.totalChecks}`;
    const round =
        acceptance.round === undefined
            ? acceptance.roundCount !== undefined && acceptance.roundCount > 1
                ? form === 'compact'
                    ? `r${acceptance.roundCount}`
                    : `latest of ${acceptance.roundCount}`
                : undefined
            : form === 'compact'
              ? `r${acceptance.round}`
              : `round ${acceptance.round}`;
    return [tally, round].filter(Boolean).join(' · ') || undefined;
}

/**
 * Every row that offers `caxri.project-status.refresh` says the same word. The command has one registered title
 * ("Refresh Project Status"), so a row calling it `Retry` and the next one calling it `Recheck` invented a second and a
 * third name for it, and the user had no way to know the three buttons ran the same thing.
 */
export const REFRESH_ACTION_LABEL = 'Refresh';

/**
 * The product word for a provider state, and the only place one is written. Every surface that shows a state (a check
 * badge, a deployment row, the `CI …` labels) reads it from here, so the raw provider enum (`success`, `failure`,
 * `cancelled`) never reaches a user and one spelling of "canceled" survives.
 */
const stateLabels: Record<ProjectStatusState, string> = {
    success: 'passed',
    failure: 'failed',
    cancelled: 'canceled',
    // "running", not "pending": the point of splitting these two states is that one of them has actually started.
    pending: 'running',
    queued: 'queued',
    neutral: 'neutral',
    unknown: 'unknown',
};

export function projectStatusStateLabel(state: ProjectStatusState): string {
    return stateLabels[state];
}

/**
 * What a pull request's aggregated check state is called.
 */
export function checkLabel(state: ProjectStatusState): string {
    return `CI ${stateLabels[state]}`;
}

export function deploymentStateLabel(deployment: ProjectStatusDeployment): string {
    // Vercel reports a cancellation as `neutral`; the row has to keep saying which one it was.
    return deployment.state === 'neutral' ? 'canceled' : stateLabels[deployment.state];
}

/**
 * The branch row's trailing word for how the branch stands against origin.
 *
 * `unknown` and `unsupported` deliberately do not share one: a probe that failed and a remote nobody can probe are
 * different answers, and neither is "there is nothing to report". Collapsing both into `Unknown` is the pattern
 * `7763bd34` removed from the status-bar chip, and it survived here.
 */
export function publicationLabel(publication: ProjectStatusPublication): string {
    const labels: Record<ProjectStatusPublication['state'], string> = {
        'checking': 'Checking origin…',
        'unpublished': 'Not on origin',
        'published': 'On origin',
        'synced': 'Synced',
        'ahead': `↑${publication.ahead ?? 0}`,
        'behind': `↓${publication.behind ?? 0}`,
        'diverged': `↑${publication.ahead ?? 0} ↓${publication.behind ?? 0}`,
        'unknown': 'Check failed',
        'no-origin': 'No origin',
        'unsupported': 'Not supported',
        'detached': 'Detached HEAD',
        'unborn': 'No commits',
    };
    return labels[publication.state];
}

export function publicationDescription(state: ProjectStatusPublication['state']): string {
    const descriptions: Record<ProjectStatusPublication['state'], string> = {
        'unpublished':
            'No same-named branch exists on origin. It may exist on another remote or under another name.',
        'published':
            'The branch exists on origin, but local history is insufficient to compare commits. This does not confirm that every local commit has been pushed.',
        'synced': 'Local and origin branch tips match at the checked time.',
        'ahead': 'Local commits not on the compared origin branch at the checked time.',
        'behind': 'Origin commits not on the local branch at the checked time.',
        'diverged': 'Both branches have commits absent from the other at the checked time.',
        'unknown': 'Could not verify the branch on origin. Refresh Project Status to check again.',
        'unsupported': 'Remote verification currently supports GitHub origins only.',
        'no-origin': 'This repository has no origin remote.',
        'detached': 'HEAD is not attached to a local branch.',
        'unborn': 'This branch has no commits yet.',
        'checking': 'Checking the same-named branch on origin.',
    };
    return descriptions[state];
}

export function durationLabel(durationMs: number | undefined): string | undefined {
    if (durationMs === undefined) return undefined;
    const seconds = Math.round(durationMs / 1_000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

export function ignoredChecksLabel(count: number): string {
    return `${count} ignored check${count === 1 ? '' : 's'}`;
}

export function unresolvedCommentsLabel(count: number): string {
    return `${count} unresolved ${count === 1 ? 'comment' : 'comments'}`;
}

/**
 * `file:line` for an inline thread, the bare file name for a file-level one, and `General` for a thread GitHub anchored
 * to no file at all. The directory stays on the hover card: a narrow panel truncated full paths to `docs/api/bro…`,
 * which cut exactly the part that tells threads apart.
 */
export function reviewThreadLocation(
    thread: Pick<ProjectStatusReviewThread, 'line' | 'path'>,
): string {
    if (!thread.path) return 'General';
    const fileName = thread.path.slice(thread.path.lastIndexOf('/') + 1);
    return thread.line === undefined ? fileName : `${fileName}:${thread.line}`;
}

/**
 * Collapses a Markdown comment to one line for the row's description. The hover card keeps the longer text.
 */
function oneLine(text: string, maxLength: number): string {
    const collapsed = text.replaceAll(/\s+/gu, ' ').trim();
    return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

/**
 * Review comments are authored Markdown, so the hover card renders them instead of a flattened excerpt. The bound stays
 * under the protocol's 8 KiB tooltip Markdown limit; a clipped comment is still one click away on GitHub.
 */
const MAX_TOOLTIP_MARKDOWN = 8_000;

export function clipMarkdown(text: string): string {
    return text.length > MAX_TOOLTIP_MARKDOWN
        ? `${text.slice(0, MAX_TOOLTIP_MARKDOWN - 1)}…`
        : text;
}

/**
 * Reduces a Markdown comment to readable prose for the row's one-line excerpt. The hover card parses the full Markdown;
 * the excerpt only needs to stop showing tags, image syntax, and emphasis markers, so a few rewrites suffice instead of
 * bundling a parser into the extension.
 */
export function markdownExcerpt(text: string, maxLength: number): string {
    const prose = text
        .replaceAll(/<[^>]*>/gu, '')
        .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
        .replaceAll(/(\*\*|__|`|~~)/gu, '')
        .replaceAll(/^\s{0,3}(#{1,6}|[>\-*+]|\d+\.)\s+/gmu, '');
    return oneLine(prose, maxLength);
}

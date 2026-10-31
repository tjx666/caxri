import type {
    AcceptanceStatus,
    AcceptanceVerdict,
    ProjectStatusAcceptance,
    ProjectStatusDeployment,
    ProjectStatusRepository,
    ProjectStatusReviewThread,
    ProjectStatusState,
} from 'caxri';
import { l10n } from 'caxri';

type ProjectStatusPublication = NonNullable<ProjectStatusRepository['publication']>;

/**
 * Lifecycle wording, spelled out rather than title-cased from the enum. `delivered` and `accepted` differ by who acted
 * (the Agent finished, a person agreed), and that distinction is the whole reason a reviewer opens this row.
 *
 * Kept byte-identical, in English and in `l10n/bundle.l10n.zh-cn.json`, to `STATUS_LABELS` in the Desktop status bar's
 * `acceptance-label` module, together with {@link acceptanceVerdictLabels} and its counterpart there. The two cannot
 * share a module: the architecture boundary forbids Desktop importing `extension-api`, and `extension-api` imports
 * nothing, so the copies are the contract: change one and this row and the status bar chip name the same report two
 * different things, with nothing failing.
 */
const acceptanceStatusLabels: Record<AcceptanceStatus, () => string> = {
    pending: () => l10n.t('Not started'),
    planned: () => l10n.t('Plan ready'),
    verifying: () => l10n.t('Verifying'),
    repairing: () => l10n.t('Repairing'),
    delivered: () => l10n.t('Awaiting review'),
    accepted: () => l10n.t('Accepted'),
    closed: () => l10n.t('Closed'),
    rejected: () => l10n.t('Rejected'),
    errored: () => l10n.t('Errored'),
};

const acceptanceVerdictLabels: Record<AcceptanceVerdict, () => string> = {
    passed: () => l10n.t('Checks passed'),
    failed: () => l10n.t('Checks failed'),
    uncertain: () => l10n.t('Checks inconclusive'),
};

export function acceptanceStatusLabel(status: AcceptanceStatus): string {
    return acceptanceStatusLabels[status]();
}

export function acceptanceVerdictLabel(verdict: AcceptanceVerdict): string {
    return acceptanceVerdictLabels[verdict]();
}

/**
 * The row's own text. The subject is what a person recognizes; the opaque id never appears, because it identifies a
 * private acceptance record and tells a reader nothing it could not get from the link itself.
 */
export function acceptanceRowLabel(acceptance: ProjectStatusAcceptance): string {
    return acceptance.title ?? l10n.t('Acceptance report');
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
                    : l10n.t('latest of {count}', { count: acceptance.roundCount })
                : undefined
            : form === 'compact'
              ? `r${acceptance.round}`
              : l10n.t('round {round}', { round: acceptance.round });
    return [tally, round].filter(Boolean).join(' · ') || undefined;
}

/**
 * Every row that offers `caxri.project-status.refresh` says the same word. The command has one registered title
 * ("Refresh Project Status"), so a row calling it `Retry` and the next one calling it `Recheck` invented a second and a
 * third name for it, and the user had no way to know the three buttons ran the same thing.
 */
export function refreshActionLabel(): string {
    return l10n.t('Refresh');
}

/**
 * The product word for a provider state, and the only place one is written. Every surface that shows a state (a check
 * badge, a deployment row, the `CI …` labels) reads it from here, so the raw provider enum (`success`, `failure`,
 * `cancelled`) never reaches a user and one spelling of "canceled" survives.
 */
const stateLabels: Record<ProjectStatusState, () => string> = {
    success: () => l10n.t('passed'),
    failure: () => l10n.t('failed'),
    cancelled: () => l10n.t('canceled'),
    // "running", not "pending": the point of splitting these two states is that one of them has actually started.
    pending: () => l10n.t('running'),
    queued: () => l10n.t('queued'),
    neutral: () => l10n.t('neutral'),
    unknown: () => l10n.t('unknown'),
};

export function projectStatusStateLabel(state: ProjectStatusState): string {
    return stateLabels[state]();
}

/**
 * What a pull request's aggregated check state is called. Each is one whole message, so a translation can place the
 * state word where its language wants it.
 */
const checkLabels: Record<ProjectStatusState, () => string> = {
    success: () => l10n.t('CI passed'),
    failure: () => l10n.t('CI failed'),
    cancelled: () => l10n.t('CI canceled'),
    pending: () => l10n.t('CI running'),
    queued: () => l10n.t('CI queued'),
    neutral: () => l10n.t('CI neutral'),
    unknown: () => l10n.t('CI unknown'),
};

export function checkLabel(state: ProjectStatusState): string {
    return checkLabels[state]();
}

export function deploymentStateLabel(deployment: ProjectStatusDeployment): string {
    // Vercel reports a cancellation as `neutral`; the row has to keep saying which one it was.
    return deployment.state === 'neutral'
        ? l10n.t('canceled')
        : projectStatusStateLabel(deployment.state);
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
        'checking': l10n.t('Checking origin…'),
        'unpublished': l10n.t('Not on origin'),
        'published': l10n.t('On origin'),
        'synced': l10n.t('Synced'),
        'ahead': `↑${publication.ahead ?? 0}`,
        'behind': `↓${publication.behind ?? 0}`,
        'diverged': `↑${publication.ahead ?? 0} ↓${publication.behind ?? 0}`,
        'unknown': l10n.t('Check failed'),
        'no-origin': l10n.t('No origin'),
        'unsupported': l10n.t('Not supported'),
        'detached': l10n.t('Detached HEAD'),
        'unborn': l10n.t('No commits'),
    };
    return labels[publication.state];
}

export function publicationDescription(state: ProjectStatusPublication['state']): string {
    const descriptions: Record<ProjectStatusPublication['state'], string> = {
        'unpublished': l10n.t(
            'No same-named branch exists on origin. It may exist on another remote or under another name.',
        ),
        'published': l10n.t(
            'The branch exists on origin, but local history is insufficient to compare commits. This does not confirm that every local commit has been pushed.',
        ),
        'synced': l10n.t('Local and origin branch tips match at the checked time.'),
        'ahead': l10n.t('Local commits not on the compared origin branch at the checked time.'),
        'behind': l10n.t('Origin commits not on the local branch at the checked time.'),
        'diverged': l10n.t('Both branches have commits absent from the other at the checked time.'),
        'unknown': l10n.t(
            'Could not verify the branch on origin. Refresh Project Status to check again.',
        ),
        'unsupported': l10n.t('Remote verification currently supports GitHub origins only.'),
        'no-origin': l10n.t(
            'Project Status compares this branch with a GitHub remote named origin, and this repository has none. Add one with `git remote add origin <url>`, then refresh.',
        ),
        'detached': l10n.t('HEAD is not attached to a local branch.'),
        'unborn': l10n.t('This branch has no commits yet.'),
        'checking': l10n.t('Checking the same-named branch on origin.'),
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
    return count === 1
        ? l10n.t('{count} ignored check', { count })
        : l10n.t('{count} ignored checks', { count });
}

export function ignoredChecksHiddenLabel(count: number): string {
    return count === 1
        ? l10n.t('{count} ignored check hidden', { count })
        : l10n.t('{count} ignored checks hidden', { count });
}

export function unresolvedCommentsLabel(count: number): string {
    return count === 1
        ? l10n.t('{count} unresolved comment', { count })
        : l10n.t('{count} unresolved comments', { count });
}

/**
 * `file:line` for an inline thread, the bare file name for a file-level one, and `General` for a thread GitHub anchored
 * to no file at all. The directory stays on the hover card: a narrow panel truncated full paths to `docs/api/bro…`,
 * which cut exactly the part that tells threads apart.
 */
export function reviewThreadLocation(
    thread: Pick<ProjectStatusReviewThread, 'line' | 'path'>,
): string {
    if (!thread.path) return l10n.t('General');
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

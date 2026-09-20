/**
 * Presentation vocabulary for the Status panel: the glyph, tone, and text each provider state resolves to, plus the
 * row-level formatting that vocabulary feeds. Kept beside the tree builder rather than inside it so one state's
 * appearance is decided in one place — `status-tree.ts` assembles rows and never re-decides what a state looks like.
 */
import type {
    ProjectStatusDeployment,
    ProjectStatusRepository,
    ProjectStatusState,
    TreeItemRichTooltip,
    TreeItemTooltipRow,
} from 'caxri';

import { deploymentStateLabel } from './status-labels';

/**
 * A queued check gets the static dot GitHub draws for one, not the spinner. The spinner stays for work that is actually
 * executing — it is the only honest use of motion here, and a twenty-check run that has not started spun twenty of them
 * while nothing moved, which is what made the panel unreadable.
 */
export const stateIcons: Record<ProjectStatusState, string> = {
    success: 'circle-check',
    failure: 'circle-x',
    cancelled: 'circle-slash',
    pending: 'loading',
    queued: 'circle-small-filled',
    neutral: 'circle-outline',
    unknown: 'circle-dot',
};

/**
 * Vercel cancellation stays neutral for aggregation but must remain recognizable in deployment rows.
 */
const deploymentIcons: Record<ProjectStatusState, string> = {
    ...stateIcons,
    neutral: 'circle-slash',
};

/**
 * A production deployment that succeeded is the one row on this panel that means the work is live, and a green check
 * shared with every passing CI check does not say that. It gets the rocket instead — the glyph Vercel's own dashboard
 * uses — so the answer to "did it ship?" is readable without comparing a row's label to its icon. Every other state,
 * and every preview deployment, keeps the shared state glyph: only success is news.
 */
export function deploymentIcon(deployment: ProjectStatusDeployment): string {
    return deployment.environment === 'production' && deployment.state === 'success'
        ? 'rocket'
        : deploymentIcons[deployment.state];
}

const linearStateIcons: Partial<
    Record<NonNullable<ProjectStatusRepository['linearIssues'][number]['stateType']>, string>
> = {
    backlog: 'linear-backlog',
    canceled: 'linear-canceled',
    completed: 'linear-completed',
    duplicate: 'linear-duplicate',
    started: 'linear-started',
    triage: 'linear-triage',
    unstarted: 'linear-unstarted',
};

/**
 * Badge tone for the state name shown in an issue's hover card. Deliberately not `stateTones[linearState(…)]`: that
 * mapping calls every `started` state pending, and Linear files "In Review" and "Ready to Merge" under `started`
 * alongside "In Progress". Calling those three the same kind of in-flight is the honest reading; the icon carries the
 * workspace's own color for the distinction.
 */
export const linearBadgeTones: Partial<
    Record<
        NonNullable<ProjectStatusRepository['linearIssues'][number]['stateType']>,
        'danger' | 'neutral' | 'success' | 'warning'
    >
> = {
    completed: 'success',
    triage: 'warning',
};

export const stateTones: Record<ProjectStatusState, 'danger' | 'neutral' | 'success' | 'warning'> =
    {
        success: 'success',
        failure: 'danger',
        cancelled: 'neutral',
        pending: 'warning',
        // Queued shares the in-flight colour with `pending`: the run has not finished either way, and the glyph — not the
        // tone — is what separates waiting for a runner from running.
        queued: 'warning',
        neutral: 'neutral',
        unknown: 'neutral',
    };

/**
 * `label` is deliberately absent from either row's own description: the glyph already says the lifecycle in the same
 * colors GitHub uses — green open, grey draft, purple merged, red closed — so repeating "Open" beside it spent the
 * row's scarce width restating the icon. It stays on the hover card's badge and in the accessible name, which is where
 * a reader who cannot use the color needs it.
 */
export const pullRequestPresentation = {
    open: { icon: 'git-pull-request-open', label: 'Open', tone: 'success' },
    draft: { icon: 'git-pull-request-draft', label: 'Draft', tone: 'neutral' },
    merged: { icon: 'git-merge', label: 'Merged', tone: 'neutral' },
    closed: { icon: 'git-pull-request-closed', label: 'Closed', tone: 'danger' },
} as const;

export const repoPresentation: Record<
    ProjectStatusRepository['kind'],
    { description?: string; icon: string }
> = {
    primary: { icon: 'repo' },
    worktree: { description: 'worktree', icon: 'worktree' },
    nested: { description: 'nested', icon: 'repo' },
    submodule: { description: 'submodule', icon: 'archive' },
};

/**
 * The parts a row contributes to its hover card. `title` defaults to the row label; the row's own `url` is appended as
 * the trailing `link` row by `richTooltip` in `status-tree.ts`.
 */
export interface StatusTooltip {
    badge?: TreeItemRichTooltip['badge'];
    description?: string;
    rows?: readonly TreeItemTooltipRow[];
    title?: string;
}

/**
 * A tooltip row value is capped at 2048 characters by the process boundary, while a provider URL may be much longer.
 * Clamping well below that bound keeps one pathological deployment URL from rejecting the whole `getChildren` batch.
 */
const MAX_LINK_TEXT_LENGTH = 256;

/**
 * Drops the scheme so a link stays readable inside the bounded hover card at SecondarySidebar width. The row keeps the
 * untouched `url`, so a clamped display text still opens the full destination.
 */
export function linkText(url: string): string {
    const text = url.replace(/^https?:\/\//, '');
    return text.length > MAX_LINK_TEXT_LENGTH
        ? `${text.slice(0, MAX_LINK_TEXT_LENGTH - 1)}…`
        : text;
}

/**
 * Seven hex characters is the abbreviation Git and GitHub both display, so a row and the commit page a reader compares
 * it against agree without truncating a Vercel deployment's full 40-character SHA differently from either.
 */
function shortCommitSha(sha: string): string {
    return sha.slice(0, 7);
}

/**
 * What the deployment built, not where it landed. A Vercel alias is a generated hash that is already unreadable at
 * SecondarySidebar width, while the commit subject answers the question a deployment list is actually asked. Falls back
 * to the alias for a direct CLI upload, which carries no Git provenance.
 */
export function deploymentRowLabel(deployment: ProjectStatusDeployment): string {
    return deployment.commit?.message ?? deployment.hostname;
}

export function deploymentRowDescription(deployment: ProjectStatusDeployment): string | undefined {
    return deployment.commit ? shortCommitSha(deployment.commit.sha) : undefined;
}

/**
 * Screen readers keep every identifier the visible row had to give up — the commit subject and the alias — while a part
 * the label already announced is dropped rather than repeated.
 */
export function deploymentAccessibilityLabel(
    lead: string,
    detail: string,
    deployment: ProjectStatusDeployment,
): string {
    return [`${lead}, ${detail}`, deployment.commit?.message, deployment.hostname]
        .filter((part) => part !== undefined && part !== lead)
        .join(' · ');
}

export function deploymentTooltip(
    title: string,
    deployment: ProjectStatusDeployment,
): StatusTooltip {
    const { commit } = deployment;
    return {
        title,
        badge: { label: deploymentStateLabel(deployment), tone: stateTones[deployment.state] },
        rows: [
            ...(commit
                ? [
                      {
                          label: 'commit',
                          value: [shortCommitSha(commit.sha), commit.message]
                              .filter(Boolean)
                              .join(' '),
                          ...(commit.url && { url: commit.url }),
                      },
                  ]
                : []),
            ...(commit?.authorLogin ? [{ label: 'author', value: commit.authorLogin }] : []),
            { label: 'alias', value: deployment.hostname, url: deployment.url },
            ...(deployment.inspectorUrl
                ? [{ label: 'inspect', value: 'details', url: deployment.inspectorUrl }]
                : []),
            ...(deployment.createdAt === undefined
                ? []
                : [
                      {
                          label: 'created',
                          value: new Date(deployment.createdAt).toLocaleString(),
                      },
                  ]),
        ],
    };
}

function linearState(
    stateType: ProjectStatusRepository['linearIssues'][number]['stateType'],
): ProjectStatusState {
    if (stateType === 'completed') return 'success';
    if (stateType === 'canceled' || stateType === 'duplicate') return 'neutral';
    if (stateType === 'started') return 'pending';
    return 'unknown';
}

export function linearIcon(
    stateType: ProjectStatusRepository['linearIssues'][number]['stateType'],
): string {
    const customIcon = stateType ? linearStateIcons[stateType] : undefined;
    return customIcon ?? stateIcons[linearState(stateType)];
}

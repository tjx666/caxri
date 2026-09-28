/**
 * Presentation vocabulary for the Status panel: the glyph, tone, and text each provider state resolves to, plus the
 * row-level formatting that vocabulary feeds. Kept beside the tree builder rather than inside it so one state's
 * appearance is decided in one place — `status-tree.ts` assembles rows and never re-decides what a state looks like.
 */
import type {
    ProjectStatusAcceptance,
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
        ? 'rocket-success'
        : deploymentIcons[deployment.state];
}

/**
 * The glyph family acceptance rows own. Every other row in this tree reports a machine's verdict with a circle — a CI
 * check, a deployment, a Linear state — so a report a _person_ still has to sign off on was indistinguishable from the
 * run that produced it. The shield says "this is the sign-off" by shape alone, and the state only picks which shield,
 * so colour stays the secondary signal it is everywhere else here.
 *
 * `pending` deliberately resolves to a static glyph rather than the `loading` spinner the shared state vocabulary gives
 * it. A verification round can sit in flight for an hour; animating that told the reader something was about to happen
 * and then spun for the rest of the afternoon.
 */
const acceptanceIcons: Record<ProjectStatusState, string> = {
    success: 'shield-check',
    failure: 'shield-x',
    pending: 'shield-ellipsis',
    // Accepted for verification and not started: the shield is there, it just has nothing to report yet.
    queued: 'shield',
    cancelled: 'shield-minus',
    neutral: 'shield-minus',
    /**
     * The report's own lookup failed, so the panel knows nothing about this branch's acceptance. Deliberately not the
     * plain shield the `queued` row wears: that one has nothing to report _yet_, and this one cannot say whether there
     * is something to report at all. Matches `STATE_PRESENTATION` in the Desktop status bar's `acceptance-status`.
     */
    unknown: 'shield-alert',
};

export function acceptanceIcon(acceptance: Pick<ProjectStatusAcceptance, 'state'>): string {
    return acceptanceIcons[acceptance.state];
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
    markdown?: string;
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
 * The emoji run this repository's own commit convention puts at the front of a subject line (gitmoji), plus the space
 * that follows it. `Extended_Pictographic` alone misses a sequence joined by a variation selector or ZWJ, so both are
 * folded into the same run rather than left to stop the match one code point early.
 */
const LEADING_GITMOJI_PATTERN = /^(?:\p{Extended_Pictographic}[\u{FE0F}\u{200D}]?)+\s*/u;

/**
 * Drops a leading gitmoji from a commit subject for the one row that also carries its own state icon
 * (`deploymentIcon`): stacked together, an unrelated glyph baked into the label text read as a doubled icon rather than
 * two different facts (#1291). Falls back to the untouched message when stripping would leave nothing — a message that
 * was only ever the emoji is not improved by deleting it.
 */
function stripLeadingGitmoji(message: string): string {
    const stripped = message.replace(LEADING_GITMOJI_PATTERN, '').trim();
    return stripped.length > 0 ? stripped : message;
}

/**
 * What the deployment built, not where it landed. A Vercel alias is a generated hash that is already unreadable at
 * SecondarySidebar width, while the commit subject answers the question a deployment list is actually asked. Falls back
 * to the alias for a direct CLI upload, which carries no Git provenance.
 */
export function deploymentRowLabel(deployment: ProjectStatusDeployment): string {
    const message = deployment.commit?.message ?? deployment.hostname;
    return deployment.commit ? stripLeadingGitmoji(message) : message;
}

/**
 * `Production` / `Preview`, the same word the summary rows already use as their own label. Kept as one function so a
 * reader never sees the panel spell an environment two different ways.
 */
export function deploymentEnvironmentLabel(
    environment: ProjectStatusDeployment['environment'],
): string {
    return environment === 'production' ? 'Production' : 'Preview';
}

/**
 * The `Deployments` child row's own description: which environment this is and whether it is the branch's current
 * Production or Preview, as text a reader can select and a screen reader can announce instead of a bare trailing glyph
 * (#1291). The short SHA stays on the hover card: next to the commit subject it is a hash a person does not read.
 */
export function branchDeploymentRowDescription(
    deployment: ProjectStatusDeployment,
    isLatest: boolean,
): string {
    return [deploymentEnvironmentLabel(deployment.environment), isLatest ? 'Latest' : undefined]
        .filter((part): part is string => part !== undefined)
        .join(' · ');
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

import type {
    PullRequestUnavailable,
    SessionPullRequest,
    SessionPullRequests,
} from '@caxri/protocol';

import type { SessionActivityPresentation } from './session-activity';

export type SessionPullRequestIcon = 'closed' | 'deployed' | 'draft' | 'merged' | 'open';

/**
 * Extends the shared activity tones with `merged`, which the lifecycle glyphs have no use for. A merged PR cannot
 * borrow `success`: that tone also identifies open PRs, and at 13px shape alone does not reliably distinguish them.
 */
export type SessionPullRequestTone = SessionActivityPresentation['tone'] | 'merged';

export interface SessionPullRequestPresentation {
    ariaLabel: string;
    checksLabel?: string;
    checksTone?: 'danger' | 'warning' | 'success' | 'neutral';
    /**
     * Short status word shown beside the PR number in the hover card.
     */
    label: string;
    icon: SessionPullRequestIcon;
    /**
     * Colored text/icon classes for the sidebar glyph and hover-card chip.
     */
    tone: SessionPullRequestTone;
}

/**
 * One Session row's share of the sidebar-wide pull-request snapshot: the discovered pull request, the reason a lookup
 * failed, or neither.
 */
export interface SessionPullRequestSlice {
    pullRequest?: SessionPullRequest;
    unavailable?: PullRequestUnavailable;
}

/**
 * The slice of a Session with no discovered pull request and no failed lookup, as one shared value so every such row
 * reads the same reference.
 */
export const NO_SESSION_PULL_REQUEST: SessionPullRequestSlice = {};

/**
 * Projects the whole-sidebar snapshot onto one Session.
 *
 * This exists to narrow a subscription, not to save a property lookup. The snapshot carries a `refreshedAt` timestamp,
 * so every poll returns a value that is never deeply equal to the previous one, structural sharing cannot reuse the old
 * reference, and anything subscribed to the snapshot itself re-renders on every tick even when no pull request moved. A
 * per-Session slice leaves the timestamp behind, so a row's value stays deeply equal, and therefore referentially
 * stable, until that Session's own pull request changes.
 */
export function selectSessionPullRequest(
    snapshot: SessionPullRequests | undefined,
    sessionId: string,
): SessionPullRequestSlice {
    const pullRequest = snapshot?.pullRequests[sessionId];
    const unavailable = snapshot?.unavailable?.[sessionId];
    if (!pullRequest && !unavailable) return NO_SESSION_PULL_REQUEST;
    return { ...(pullRequest && { pullRequest }), ...(unavailable && { unavailable }) };
}

const STATE_LABELS: Record<SessionPullRequest['state'], string> = {
    closed: 'Closed',
    draft: 'Draft',
    merged: 'Merged',
    open: 'Open',
};

/**
 * What a merged pull request became once the hosting provider rebuilt production from it.
 *
 * "Merged" is the last thing GitHub can say, but it is not the thing a maintainer is waiting for: the delivery is only
 * done when production is serving it. The Server attaches this field solely when the live production deployment was
 * built from this pull request's own merge commit, so a row showing the rocket is showing its own delivery. A build
 * that is still running, or that failed, keeps the same glyph and changes only the color: the shape answers "did this
 * ship?" and the color answers "how did it go?".
 *
 * A deployment with nothing to report (canceled, or a state Vercel does not name) falls back to the merged glyph.
 */
function deployedPresentation(
    deployment: SessionPullRequest['deployment'],
    number: number,
): SessionPullRequestPresentation | undefined {
    const base = `Pull request #${number} merged`;
    switch (deployment?.state) {
        case 'success':
            return {
                ariaLabel: `${base} and deployed to production.`,
                icon: 'deployed',
                label: 'Deployed',
                // The merged violet, not the open green: a shipped rocket is where a merged pull request goes next,
                // and at 13px a green rocket beside a green open PR read as the same state.
                tone: 'merged',
                checksLabel: 'Deployed to production',
                checksTone: 'success',
            };
        case 'failure':
            return {
                ariaLabel: `${base}, production deployment failed.`,
                icon: 'deployed',
                label: 'Deploy failed',
                tone: 'danger',
                checksLabel: 'Production deployment failed',
                checksTone: 'danger',
            };
        case 'pending':
        case 'queued':
            return {
                ariaLabel: `${base}, deploying to production.`,
                icon: 'deployed',
                label: 'Deploying',
                tone: 'warning',
                checksLabel: 'Deploying to production',
                checksTone: 'warning',
            };
        default:
            return undefined;
    }
}

/**
 * Keeps lifecycle color independent of CI: a red open glyph was mistaken for a closed PR at sidebar size. Checks use a
 * hover-card text; terminal lifecycle states suppress stale checks. Project-level failures belong to the Status tab.
 */
export function sessionPullRequestPresentation(
    pullRequest: SessionPullRequest,
): SessionPullRequestPresentation {
    const label = STATE_LABELS[pullRequest.state];
    const base = `Pull request #${pullRequest.number} ${label.toLowerCase()}`;
    switch (pullRequest.state) {
        case 'merged':
            return (
                deployedPresentation(pullRequest.deployment, pullRequest.number) ?? {
                    ariaLabel: `${base}.`,
                    icon: 'merged',
                    label,
                    tone: 'merged',
                }
            );
        case 'closed':
            return { ariaLabel: `${base}.`, icon: 'closed', label, tone: 'danger' };
        case 'draft':
            return { ariaLabel: `${base}.`, icon: 'draft', label, tone: 'neutral' };
        case 'open': {
            if (pullRequest.checks === 'cancelled')
                return {
                    ariaLabel: `${base}, checks cancelled.`,
                    icon: 'open',
                    label,
                    tone: 'success',
                    checksLabel: 'Checks cancelled',
                    checksTone: 'neutral',
                };
            if (pullRequest.checks === 'failure')
                return {
                    ariaLabel: `${base}, checks failing.`,
                    icon: 'open',
                    label,
                    tone: 'success',
                    checksLabel: 'Checks failing',
                    checksTone: 'danger',
                };
            if (pullRequest.checks === 'pending')
                return {
                    ariaLabel: `${base}, checks running.`,
                    icon: 'open',
                    label,
                    tone: 'success',
                    checksLabel: 'Checks running',
                    checksTone: 'warning',
                };
            /*
             * A row this narrow has space for one word about CI, and "waiting for a runner" and "running" are the same
             * answer to the only question it is asked: is CI still deciding? The Status panel is where the two are
             * drawn apart. Without this branch the fallback below drops the CI state entirely, which is how a
             * repository reporting through commit statuses (always `queued` until it concludes) lost its badge for
             * the whole run.
             */
            if (pullRequest.checks === 'queued')
                return {
                    ariaLabel: `${base}, checks queued.`,
                    icon: 'open',
                    label,
                    tone: 'success',
                    checksLabel: 'Checks queued',
                    checksTone: 'warning',
                };
            if (pullRequest.checks === 'success')
                return {
                    ariaLabel: `${base}, checks passing.`,
                    icon: 'open',
                    label,
                    tone: 'success',
                    checksLabel: 'Checks passing',
                    checksTone: 'success',
                };
            return { ariaLabel: `${base}.`, icon: 'open', label, tone: 'success' };
        }
    }
}

export function sessionPullRequestToneClassName(tone: SessionPullRequestTone): string {
    switch (tone) {
        case 'merged':
            return 'text-merged';
        case 'success':
            return 'text-success';
        case 'warning':
            return 'text-warning';
        case 'danger':
            return 'text-danger';
        case 'neutral':
            return 'text-muted';
    }
}

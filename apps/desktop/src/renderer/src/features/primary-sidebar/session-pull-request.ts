import type { SessionPullRequest } from '@caxri/protocol';

import type { SessionActivityPresentation } from './session-activity';

export type SessionPullRequestIcon = 'closed' | 'draft' | 'merged' | 'open';

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

const STATE_LABELS: Record<SessionPullRequest['state'], string> = {
    closed: 'Closed',
    draft: 'Draft',
    merged: 'Merged',
    open: 'Open',
};

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
            return { ariaLabel: `${base}.`, icon: 'merged', label, tone: 'merged' };
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

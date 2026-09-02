import type { SessionPullRequest } from '@caxri/protocol';

import type { SessionActivityPresentation } from './session-activity';

export type SessionPullRequestIcon = 'closed' | 'draft' | 'merged' | 'open';

export interface SessionPullRequestPresentation {
    ariaLabel: string;
    /**
     * Short status word shown beside the PR number in the hover card.
     */
    label: string;
    icon: SessionPullRequestIcon;
    /**
     * Colored text/icon classes for the sidebar glyph and hover-card chip.
     */
    tone: SessionActivityPresentation['tone'];
}

const STATE_LABELS: Record<SessionPullRequest['state'], string> = {
    closed: 'Closed',
    draft: 'Draft',
    merged: 'Merged',
    open: 'Open',
};

/**
 * Projects a Session's pull request onto the sidebar glyph. The state lives in the glyph shape so a failing check on an
 * open PR (danger tone) never reads as "closed"; color only adds emphasis. Merged borrows the success tone — it is the
 * "this work landed" signal the row exists for — and CI tone overrides only while the PR is still open, matching the
 * convention shared by Codex, Orca, Synara, and Paseo.
 */
export function sessionPullRequestPresentation(
    pullRequest: SessionPullRequest,
): SessionPullRequestPresentation {
    const label = STATE_LABELS[pullRequest.state];
    const base = `Pull request #${pullRequest.number} ${label.toLowerCase()}`;
    switch (pullRequest.state) {
        case 'merged':
            return { ariaLabel: `${base}.`, icon: 'merged', label, tone: 'success' };
        case 'closed':
            return { ariaLabel: `${base}.`, icon: 'closed', label, tone: 'danger' };
        case 'draft':
            return { ariaLabel: `${base}.`, icon: 'draft', label, tone: 'neutral' };
        case 'open': {
            if (pullRequest.checks === 'failure')
                return {
                    ariaLabel: `${base}, checks failing.`,
                    icon: 'open',
                    label,
                    tone: 'danger',
                };
            if (pullRequest.checks === 'pending')
                return {
                    ariaLabel: `${base}, checks running.`,
                    icon: 'open',
                    label,
                    tone: 'warning',
                };
            if (pullRequest.checks === 'success')
                return {
                    ariaLabel: `${base}, checks passing.`,
                    icon: 'open',
                    label,
                    tone: 'success',
                };
            return { ariaLabel: `${base}.`, icon: 'open', label, tone: 'neutral' };
        }
    }
}

export function sessionPullRequestToneClassName(tone: SessionActivityPresentation['tone']): string {
    switch (tone) {
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

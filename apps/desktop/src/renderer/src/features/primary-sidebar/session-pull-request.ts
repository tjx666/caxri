import type { SessionPullRequest } from '@caxri/protocol';

import type { SessionActivityPresentation } from './session-activity';

export type SessionPullRequestIcon = 'closed' | 'draft' | 'merged' | 'open';

/**
 * Extends the shared activity tones with `merged`, which the lifecycle glyphs have no use for. A merged PR cannot
 * borrow `success`: that tone already means "open, checks passed", and at 13px the two glyphs differ only in shape, so
 * landed work read as a green CI run.
 */
export type SessionPullRequestTone = SessionActivityPresentation['tone'] | 'merged';

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
    tone: SessionPullRequestTone;
}

const STATE_LABELS: Record<SessionPullRequest['state'], string> = {
    closed: 'Closed',
    draft: 'Draft',
    merged: 'Merged',
    open: 'Open',
};

/**
 * Projects a Session's pull request onto the sidebar glyph. The state lives in the glyph shape so a failing check on an
 * open PR (danger tone) never reads as "closed". Color is the second, faster channel: merged takes its own violet after
 * sharing `success` with a passing CI run made landed work unreadable at glyph size, matching the merged-is-purple
 * convention GitHub established. CI tone overrides only while the PR is still open, as in Codex, Orca, Synara, and
 * Paseo.
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

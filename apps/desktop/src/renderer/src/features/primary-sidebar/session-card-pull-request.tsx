import type { SessionPullRequest } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { SessionPullRequestPresentation } from './session-pull-request';
import { sessionPullRequestPresentation } from './session-pull-request';
import { SessionPullRequestIndicator } from './session-pull-request-indicator';

const CHECKS_DOT_CLASS_NAMES: Record<
    NonNullable<SessionPullRequestPresentation['checksTone']>,
    string
> = {
    danger: 'bg-danger',
    neutral: 'bg-muted',
    success: 'bg-success',
    warning: 'bg-warning',
};

/**
 * The Session's pull request as the Codex app's thread card shows it: the lifecycle glyph in its color, a CI dot on its
 * corner, and the PR title. The row's own glyph collapses while the pointer is over the row, so without this line
 * hovering a row would hide its delivery state.
 */
export function SessionCardPullRequest({ pullRequest }: { pullRequest: SessionPullRequest }) {
    const { t } = useTranslation();
    // The glyph's accessible name already states the CI rollup, so the dot stays decorative.
    const { checksTone } = sessionPullRequestPresentation(pullRequest, t);
    return (
        <p className="session-card-pull-request mt-1 mb-0 flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
            <span className="relative flex flex-none">
                <SessionPullRequestIndicator pullRequest={pullRequest} />
                {checksTone && (
                    <span
                        aria-hidden="true"
                        className={cn(
                            'absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-2 ring-elevated',
                            CHECKS_DOT_CLASS_NAMES[checksTone],
                        )}
                    />
                )}
            </span>
            <span className="min-w-0 truncate">{pullRequest.title}</span>
            <span className="flex-none tabular-nums opacity-70">#{pullRequest.number}</span>
        </p>
    );
}

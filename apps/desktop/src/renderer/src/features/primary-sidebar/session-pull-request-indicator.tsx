import type { SessionPullRequest } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import {
    GitMerge,
    GitPullRequest,
    GitPullRequestArrow,
    GitPullRequestClosed,
    Rocket,
} from 'lucide-react';

import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { SessionPullRequestIcon } from './session-pull-request';
import {
    sessionPullRequestPresentation,
    sessionPullRequestToneClassName,
} from './session-pull-request';

const ICONS: Record<SessionPullRequestIcon, LucideIcon> = {
    closed: GitPullRequestClosed,
    // The same rocket the Status panel gives a production deployment, so one delivery reads the same in both surfaces.
    deployed: Rocket,
    // The draft icon's dotted branch becomes two stray dots at 13px; the muted tone already distinguishes Draft.
    draft: GitPullRequest,
    merged: GitMerge,
    open: GitPullRequestArrow,
};

/**
 * Fixed-width pull request glyph shared by the detail card and the Session row's idle status slot. Rows reserve the
 * same width for lifecycle signals, this fallback, and the empty state.
 */
export function SessionPullRequestIndicator({
    className,
    pullRequest,
}: {
    className?: string;
    pullRequest?: SessionPullRequest;
}) {
    // `sessionPullRequestPresentation` words its labels through `translate()`; subscribing re-renders them on a language
    // change.
    useTranslation();
    if (!pullRequest) return null;
    const presentation = sessionPullRequestPresentation(pullRequest);
    const Icon = ICONS[presentation.icon];
    return (
        <span
            role="img"
            aria-label={presentation.ariaLabel}
            className={cn(
                'session-pull-request flex size-3.5 flex-none items-center justify-center',
                sessionPullRequestToneClassName(presentation.tone),
                className,
            )}
            data-pull-request-state={pullRequest.state}
            data-pull-request-checks={pullRequest.checks}
            data-pull-request-deployment={pullRequest.deployment?.state}
        >
            <Icon aria-hidden="true" size={13} />
        </span>
    );
}

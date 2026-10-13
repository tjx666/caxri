import type { LucideIcon } from 'lucide-react';
import { GitMerge, GitPullRequest, GitPullRequestArrow, GitPullRequestClosed } from 'lucide-react';

import type { pullRequestLinkState } from '../../lib/link-summary';

type PullRequestLinkState = NonNullable<ReturnType<typeof pullRequestLinkState>>;

/**
 * The same glyphs and tones the Session row's pull request indicator uses, so a linked pull request reads the same in a
 * transcript (its link icon and the Chat's pull request card) as in the PrimarySidebar.
 */
export const PULL_REQUEST_ICONS: Record<PullRequestLinkState, { icon: LucideIcon; tone: string }> =
    {
        closed: { icon: GitPullRequestClosed, tone: 'text-danger' },
        draft: { icon: GitPullRequest, tone: 'text-muted' },
        merged: { icon: GitMerge, tone: 'text-merged' },
        open: { icon: GitPullRequestArrow, tone: 'text-success' },
    };

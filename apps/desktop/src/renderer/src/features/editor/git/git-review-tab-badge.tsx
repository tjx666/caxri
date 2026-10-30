import { parseGitDiffTab } from '@caxri/protocol';

import { useCaxriQuery } from '../../../queries/client';

export function GitReviewTabBadge({
    sessionId,
    tabPath,
}: {
    sessionId: string | undefined;
    tabPath: string;
}) {
    const repoId = parseGitDiffTab(tabPath)?.repositoryId;
    const { data: comments } = useCaxriQuery(
        'gitReview.list',
        { sessionId: sessionId ?? '', repositoryId: repoId ?? '' },
        { enabled: Boolean(sessionId && repoId) },
    );
    const count = (comments ?? []).filter(
        (comment) => comment.status === 'pending' && comment.text,
    ).length;
    if (!sessionId || !repoId || count === 0) return null;
    return (
        <>
            <span
                aria-hidden="true"
                className="rounded-full bg-badge px-1.5 text-[10px] text-badge-foreground tabular-nums"
            >
                {count}
            </span>
            {/* The chip is a decorative tally; fold the fact into words so the tab's accessible name (this renders
                inside the tab's `role="tab"` button, see `work-tab.tsx`) carries it too, the same way a Git decoration
                becomes a spoken description instead of leaving only a colored letter. */}
            <span className="sr-only">
                {count} pending review comment{count === 1 ? '' : 's'}
            </span>
        </>
    );
}

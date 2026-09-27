import { parseGitDiffTab } from '@caxri/protocol';

import { useGitReviewComments } from './git-review-comments';

export function GitReviewTabBadge({
    sessionId,
    tabPath,
}: {
    sessionId: string | undefined;
    tabPath: string;
}) {
    const comments = useGitReviewComments((state) => state.comments);
    const repoId = parseGitDiffTab(tabPath)?.repositoryId;
    if (!sessionId || !repoId) return null;
    const count = comments.filter(
        (comment) =>
            comment.sessionId === sessionId &&
            comment.repositoryId === repoId &&
            comment.status === 'pending' &&
            comment.text,
    ).length;
    if (count === 0) return null;
    return (
        <>
            <span
                aria-hidden="true"
                className="rounded-full bg-badge px-1.5 text-[10px] text-badge-foreground"
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

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
        <span
            aria-hidden="true"
            className="rounded-full bg-accent px-1.5 text-[10px] text-accent-foreground"
        >
            {count}
        </span>
    );
}

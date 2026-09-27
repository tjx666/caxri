/**
 * Mounted review editor registry, kept free of Monaco so the command layer (`commands/execute.ts` through
 * `git-review-navigation-commands.ts`) can read it without loading Monaco, which needs a real `window`.
 */
import type { GitReviewComment } from './git-review-comments';

export interface ReviewEditorScope {
    sessionId: string;
    repositoryId: string;
    sourceKey: string;
    path: string;
    side: GitReviewComment['side'];
}

/**
 * One mounted review editor, registered here for the next/previous review comment commands
 * (`git-review-navigation-commands.ts`) to reach across every currently mounted diff editor pane. Deliberately scoped
 * to mounted editors only: jumping into a virtualized-out file in a multi-file "Open Changes" diff would need
 * infrastructure this feature does not have yet (see `docs/git-diff-review.md`).
 */
export interface BoundGitReviewCommentEditor {
    scope: ReviewEditorScope;
    getComments(): GitReviewComment[];
    reveal(id: string): boolean;
}

const boundReviewEditors = new Set<BoundGitReviewCommentEditor>();

export function listBoundGitReviewCommentEditors(): ReadonlySet<BoundGitReviewCommentEditor> {
    return boundReviewEditors;
}

export function registerBoundGitReviewCommentEditor(
    editor: BoundGitReviewCommentEditor,
): () => void {
    boundReviewEditors.add(editor);
    return () => boundReviewEditors.delete(editor);
}

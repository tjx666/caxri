import type { GitReviewComment } from '@caxri/protocol';
import { parseGitDiffTab } from '@caxri/protocol';
import type { editor as MonacoEditor } from 'monaco-editor';

import { caxri } from '../../lib/caxri';
import { getSelectedSession } from '../../stores/selectors';
import { getActivePaneTab } from '../workbench/pane-actions';

/**
 * Thin Server-request wrappers around the `gitReview.*` protocol methods: the comment store itself lives in Server Core
 * (see `docs/git-diff-review.md`), scoped per Session + repository, so it can survive a Renderer reload and a
 * closed-then-reopened diff tab. `gitReview.changed` events drive the `gitReview.list`/`gitReview.pending` React Query
 * cache through `queries/invalidation.ts`; callers here never touch that cache directly.
 */
export function createGitReviewComment(
    comment: Omit<GitReviewComment, 'status' | 'text'>,
): Promise<GitReviewComment> {
    return caxri.request('gitReview.add', comment);
}

export function editGitReviewComment(id: string, text: string): Promise<GitReviewComment> {
    return caxri.request('gitReview.edit', { id, text });
}

export function removeGitReviewComment(id: string): Promise<null> {
    return caxri.request('gitReview.remove', { id });
}

/**
 * A changed anchor is invalidated instead of migrating silently to an unrelated line.
 */
export function refreshGitReviewComments(
    sessionId: string,
    repoId: string,
    sourceKey: string,
    path: string,
    side: GitReviewComment['side'],
    content: string,
): Promise<null> {
    return caxri.request('gitReview.refresh', {
        sessionId,
        repositoryId: repoId,
        sourceKey,
        path,
        side,
        content,
    });
}

export function clearResolvedGitReviewComments(sessionId: string, repoId: string): Promise<null> {
    return caxri.request('gitReview.clearResolved', { sessionId, repositoryId: repoId });
}

interface ActiveReviewComment {
    editor: MonacoEditor.IStandaloneCodeEditor;
    repositoryId: string;
    sessionId: string;
    sourceKey: string;
    path: string;
    add(): void;
}

const activeReviewComment: { current?: ActiveReviewComment } = {};

export function setActiveGitReviewComment(value: ActiveReviewComment): void {
    activeReviewComment.current = value;
}

export function clearActiveGitReviewComment(editor: MonacoEditor.IStandaloneCodeEditor): void {
    if (activeReviewComment.current?.editor === editor) activeReviewComment.current = undefined;
}

export function canAddGitReviewComment(): boolean {
    const tab = getActivePaneTab();
    const diff = tab?.resource.kind === 'file' ? parseGitDiffTab(tab.resource.path) : undefined;
    const active = activeReviewComment.current;
    return Boolean(
        diff &&
        active &&
        diff.repositoryId === active.repositoryId &&
        (diff.source === 'commit' ? `commit:${diff.sha}` : diff.source) === active.sourceKey &&
        (diff.kind === 'changes' || diff.path === active.path) &&
        getSelectedSession()?.id === active.sessionId,
    );
}

export function addGitReviewComment(): void {
    if (canAddGitReviewComment()) activeReviewComment.current?.add();
}

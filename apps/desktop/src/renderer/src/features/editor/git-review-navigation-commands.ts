import { gitChangesDiffTabPath, parseGitDiffTab } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { getSelectedSession } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { didSelectSession } from '../session/session-commands';
import { getActivePaneTab } from '../workbench/pane-actions';
import { openEditorTab } from './document-commands';
import { listBoundGitReviewCommentEditors } from './git-review-bound-editors';
import type { GitReviewComment } from './git-review-comments';

export interface ReviewCommentAnchor {
    id: string;
    path: string;
    startLine: number;
    side: GitReviewComment['side'];
}

/**
 * Ordering for next/previous review comment navigation: by file path, then by start line, then by side. The
 * original/modified tie-break is a judgment call, not a derived property — the two sides render side by side, not
 * stacked, so there is no natural vertical order between a comment on one side and a comment on the other at the same
 * line. `original` sorts first because that is reading order for a change (what it was, then what it became).
 */
export function compareReviewCommentAnchors(
    a: ReviewCommentAnchor,
    b: ReviewCommentAnchor,
): number {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.side !== b.side) return a.side === 'original' ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
}

/**
 * Index of the anchor after (`direction: 1`) or before (`direction: -1`) `currentId` in `order`, wrapping around both
 * ends. Falls back to the first anchor going forward or the last one going backward when nothing is current yet (no
 * prior navigation in this scope, or the remembered anchor no longer exists). Returns `-1` for an empty order.
 */
export function nextReviewCommentIndex(
    order: readonly ReviewCommentAnchor[],
    currentId: string | undefined,
    direction: 1 | -1,
): number {
    if (order.length === 0) return -1;
    const currentIndex = currentId ? order.findIndex((anchor) => anchor.id === currentId) : -1;
    if (currentIndex === -1) return direction === 1 ? 0 : order.length - 1;
    return (currentIndex + direction + order.length) % order.length;
}

/**
 * Remembers the last-visited comment id per Session + repository, so repeated Next/Previous invocations continue from
 * where the previous one left off instead of always restarting from the first comment in view.
 */
const cursors = new Map<string, string>();

function scopeKey(sessionId: string, repoId: string): string {
    return `${sessionId}\u{0}${repoId}`;
}

/**
 * The Session + repository the active diff tab belongs to, the same way `canAddGitReviewComment` derives its own diff
 * scope. Returns `undefined` outside a Git diff tab, where "next/previous review comment" has nothing to navigate.
 */
function activeReviewDiffScope(): { sessionId: string; repositoryId: string } | undefined {
    const tab = getActivePaneTab();
    const diff = tab?.resource.kind === 'file' ? parseGitDiffTab(tab.resource.path) : undefined;
    const sessionId = getSelectedSession()?.id;
    if (!diff || !sessionId) return undefined;
    return { sessionId, repositoryId: diff.repositoryId };
}

/**
 * Anchors from every currently mounted review comment editor in `scope`, across every file and side of the active diff
 * tab. Deliberately excludes comments belonging to a file virtualized out of a multi-file "Open Changes" diff: jumping
 * to those would need infrastructure this feature does not have yet (see `docs/git-diff-review.md`).
 */
function mountedReviewCommentAnchors(scope: {
    sessionId: string;
    repositoryId: string;
}): Array<ReviewCommentAnchor & { reveal(): boolean }> {
    const anchors: Array<ReviewCommentAnchor & { reveal(): boolean }> = [];
    for (const boundEditor of listBoundGitReviewCommentEditors()) {
        if (
            boundEditor.scope.sessionId !== scope.sessionId ||
            boundEditor.scope.repositoryId !== scope.repositoryId
        )
            continue;
        for (const comment of boundEditor.getComments())
            anchors.push({
                id: comment.id,
                path: boundEditor.scope.path,
                startLine: comment.startLine,
                side: boundEditor.scope.side,
                reveal: () => boundEditor.reveal(comment.id),
            });
    }
    return anchors.toSorted(compareReviewCommentAnchors);
}

function goToReviewComment(direction: 1 | -1): void {
    const scope = activeReviewDiffScope();
    if (!scope) return;
    const order = mountedReviewCommentAnchors(scope);
    if (order.length === 0) return;
    const key = scopeKey(scope.sessionId, scope.repositoryId);
    const index = nextReviewCommentIndex(order, cursors.get(key), direction);
    const anchor = order[index];
    cursors.set(key, anchor.id);
    anchor.reveal();
}

export function canGoToReviewComment(): boolean {
    const scope = activeReviewDiffScope();
    return Boolean(scope && mountedReviewCommentAnchors(scope).length > 0);
}

export function goToNextReviewComment(): void {
    goToReviewComment(1);
}

export function goToPreviousReviewComment(): void {
    goToReviewComment(-1);
}

/**
 * The "N pending comments" entry the app-quit reminder is paired with (issue caxri#1294): always visible in the Command
 * Palette rather than gated on a synchronously warm cache, since it does its own fresh Server round-trip on invocation.
 * Opens the first repository with a pending comment; a second invocation after that repository is cleared moves on to
 * the next one.
 */
export async function showPendingReviewComments(): Promise<void> {
    const summary = await tryCommand('Could not read pending review comments', () =>
        caxri.request('gitReview.pending', {}),
    );
    const group = summary?.groups[0];
    if (!group) {
        if (summary) pushToast('info', 'No pending review comments');
        return;
    }
    if (getSelectedSession()?.id !== group.sessionId) {
        const selected = await didSelectSession(group.sessionId);
        if (!selected) return;
    }
    openEditorTab(gitChangesDiffTabPath(group.repositoryId, group.repositoryName));
}

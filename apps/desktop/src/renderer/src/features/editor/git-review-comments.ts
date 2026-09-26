import { create } from 'zustand';

import { formatFileReference } from './file-reference';

export interface GitReviewComment {
    id: string;
    sessionId: string;
    repositoryId: string;
    sourceKey: string;
    path: string;
    side: 'original' | 'modified';
    startLine: number;
    endLine: number;
    snippet: string;
    text: string;
    status: 'pending' | 'sent' | 'outdated';
}

interface GitReviewCommentState {
    comments: GitReviewComment[];
    add(comment: GitReviewComment): void;
    edit(id: string, text: string): void;
    remove(id: string): void;
    markSent(ids: readonly string[]): void;
    clearResolved(sessionId: string, repoId: string): void;
    refresh(
        sessionId: string,
        repoId: string,
        sourceKey: string,
        path: string,
        side: GitReviewComment['side'],
        content: string,
    ): void;
}

export function reviewSnippet(content: string, startLine: number, endLine: number): string {
    return content
        .split('\n')
        .slice(startLine - 1, endLine)
        .join('\n');
}

/**
 * Submit a multiline review as one bracketed paste, matching xterm's Agent paste path.
 */
export function formatReviewTerminalInput(text: string): string {
    return `\u{1B}[200~${text.replaceAll('\n', '\r')}\u{1B}[201~\r`;
}

/**
 * A changed anchor is invalidated instead of migrating silently to an unrelated line.
 */
export const useGitReviewComments = create<GitReviewCommentState>((set) => ({
    comments: [],
    add: (comment) => set((state) => ({ comments: [...state.comments, comment] })),
    edit: (id, text) =>
        set((state) => ({
            comments: state.comments.map((comment) =>
                comment.id === id ? { ...comment, text } : comment,
            ),
        })),
    remove: (id) =>
        set((state) => ({ comments: state.comments.filter((comment) => comment.id !== id) })),
    markSent: (ids) =>
        set((state) => ({
            comments: state.comments.map((comment) =>
                ids.includes(comment.id) ? { ...comment, status: 'sent' } : comment,
            ),
        })),
    clearResolved: (sessionId, repoId) =>
        set((state) => ({
            comments: state.comments.filter(
                (comment) =>
                    comment.sessionId !== sessionId ||
                    comment.repositoryId !== repoId ||
                    comment.status === 'pending',
            ),
        })),
    refresh: (sessionId, repoId, sourceKey, path, side, content) =>
        set((state) => {
            const isOutdated = (comment: GitReviewComment) =>
                comment.sessionId === sessionId &&
                comment.repositoryId === repoId &&
                comment.sourceKey === sourceKey &&
                comment.path === path &&
                comment.side === side &&
                comment.status === 'pending' &&
                reviewSnippet(content, comment.startLine, comment.endLine) !== comment.snippet;
            if (!state.comments.some(isOutdated)) return state;
            return {
                comments: state.comments.map((comment) =>
                    isOutdated(comment) ? { ...comment, status: 'outdated' as const } : comment,
                ),
            };
        }),
}));

export function formatGitReviewComments(
    comments: readonly GitReviewComment[],
    projectRoot: string | undefined,
    resolvePath: (comment: GitReviewComment) => string,
): string {
    return [
        'Please address each Git diff review comment below. Check the current file contents before editing because line numbers may have changed.',
        '',
        ...comments.flatMap((comment, index) => [
            `${index + 1}. ${formatFileReference({ path: resolvePath(comment), projectRoot, startLine: comment.startLine, endLine: comment.endLine }).trim()} (${comment.sourceKey}, ${comment.side} side)`,
            '```',
            comment.snippet,
            '```',
            comment.text,
            '',
        ]),
    ]
        .join('\n')
        .trimEnd();
}

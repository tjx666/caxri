import { beforeEach, describe, expect, it } from 'vitest';

import type { GitReviewComment } from '../git-review-comments';
import {
    formatGitReviewComments,
    formatReviewTerminalInput,
    reviewSideLabel,
    reviewSnippet,
    useGitReviewComments,
} from '../git-review-comments';

const comment: GitReviewComment = {
    id: 'comment-1',
    sessionId: 'session-1',
    repositoryId: 'repo-1',
    sourceKey: 'working',
    path: 'src/example.ts',
    side: 'modified',
    startLine: 2,
    endLine: 3,
    snippet: 'second\nthird',
    text: 'Handle this case',
    status: 'pending',
};

beforeEach(() => useGitReviewComments.setState({ comments: [] }));

describe('Git review comments', () => {
    it('serializes multiple line spans with paths, snippets, and feedback', () => {
        const result = formatGitReviewComments(
            [
                comment,
                { ...comment, id: 'comment-2', startLine: 7, endLine: 7, text: 'Rename this' },
            ],
            '/project',
            () => '/project/src/example.ts',
        );
        expect(result).toContain('@src/example.ts#L2-L3 (working, modified side)');
        expect(result).toContain('second\nthird');
        expect(result).toContain('Handle this case');
        expect(result).toContain('@src/example.ts#L7 (working, modified side)');
        expect(result).toContain('Rename this');
    });

    it('invalidates a changed anchor and excludes sent comments from later updates', () => {
        const state = useGitReviewComments.getState();
        state.add(comment);
        state.refresh(
            'session-1',
            'repo-1',
            'working',
            'src/example.ts',
            'modified',
            'first\nsecond\nthird',
        );
        expect(useGitReviewComments.getState().comments[0]?.status).toBe('pending');
        state.refresh(
            'session-1',
            'repo-1',
            'working',
            'src/example.ts',
            'modified',
            'first\nchanged\nthird',
        );
        expect(useGitReviewComments.getState().comments[0]?.status).toBe('outdated');
        state.add({ ...comment, id: 'comment-2' });
        state.markSent(['comment-2']);
        expect(useGitReviewComments.getState().comments[1]?.status).toBe('sent');
        state.clearResolved('session-1', 'repo-1');
        expect(useGitReviewComments.getState().comments).toHaveLength(0);
    });

    it('extracts an inclusive line span', () => {
        expect(reviewSnippet('one\ntwo\nthree', 2, 3)).toBe('two\nthree');
    });

    it('labels each diff side in words a reviewer would say', () => {
        expect(reviewSideLabel('original')).toBe('Old');
        expect(reviewSideLabel('modified')).toBe('New');
    });

    it('editing a sent or outdated comment returns it to pending so the fix is sendable', () => {
        const state = useGitReviewComments.getState();
        state.add(comment);
        state.markSent([comment.id]);
        expect(useGitReviewComments.getState().comments[0]?.status).toBe('sent');
        state.edit(comment.id, 'Actually, handle it this way');
        expect(useGitReviewComments.getState().comments[0]).toMatchObject({
            status: 'pending',
            text: 'Actually, handle it this way',
        });

        state.refresh('session-1', 'repo-1', 'working', 'src/example.ts', 'modified', 'changed');
        expect(useGitReviewComments.getState().comments[0]?.status).toBe('outdated');
        state.edit(comment.id, 'Updated for the new content');
        expect(useGitReviewComments.getState().comments[0]).toMatchObject({
            status: 'pending',
            text: 'Updated for the new content',
        });
    });

    it('keeps the same path in separate diff sources independent', () => {
        const state = useGitReviewComments.getState();
        state.add(comment);
        state.add({ ...comment, id: 'comment-pr', sourceKey: 'pull-request' });
        state.refresh(
            'session-1',
            'repo-1',
            'pull-request',
            'src/example.ts',
            'modified',
            'changed',
        );
        expect(useGitReviewComments.getState().comments.map((item) => item.status)).toEqual([
            'pending',
            'outdated',
        ]);
    });

    it('submits a multiline review as one bracketed paste', () => {
        expect(formatReviewTerminalInput('first\nsecond')).toBe(
            '\u{1B}[200~first\rsecond\u{1B}[201~\r',
        );
    });
});

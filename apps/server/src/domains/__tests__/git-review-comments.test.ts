import type { GitReviewComment } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { createGitReviewCommentHandlers, GitReviewCommentStore } from '../git-review-comments';

function makeComment(overrides: Partial<GitReviewComment> = {}): GitReviewComment {
    return {
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
        ...overrides,
    };
}

describe('GitReviewCommentStore', () => {
    it('scopes list() by Session and repository', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(makeComment({ id: 'a', sessionId: 'session-1', repositoryId: 'repo-1' }));
        store.add(makeComment({ id: 'b', sessionId: 'session-1', repositoryId: 'repo-2' }));
        store.add(makeComment({ id: 'c', sessionId: 'session-2', repositoryId: 'repo-1' }));

        expect(store.list('session-1', 'repo-1').map((comment) => comment.id)).toEqual(['a']);
    });

    it('emits gitReview.changed with the comment scope on add', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(makeComment({ sessionId: 'session-1', repositoryId: 'repo-1' }));

        expect(send).toHaveBeenCalledWith({
            event: 'gitReview.changed',
            payload: { sessionId: 'session-1', repositoryId: 'repo-1' },
        });
    });

    it('returns a comment unchanged aside from its status when editing text', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(makeComment({ id: 'a', status: 'outdated' }));
        send.mockClear();

        const updated = store.edit('a', 'Updated feedback');

        expect(updated).toMatchObject({ id: 'a', text: 'Updated feedback', status: 'pending' });
        expect(store.list('session-1', 'repo-1')[0]).toMatchObject({ status: 'pending' });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('throws when editing a comment that does not exist', () => {
        const store = new GitReviewCommentStore(vi.fn());
        expect(() => store.edit('missing', 'text')).toThrow('Review comment not found');
    });

    it('removes an existing comment and emits changed', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(makeComment({ id: 'a' }));
        send.mockClear();

        store.remove('a');

        expect(store.list('session-1', 'repo-1')).toEqual([]);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('does not emit changed when removing a comment that does not exist', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);

        store.remove('missing');

        expect(send).not.toHaveBeenCalled();
    });

    it('marks multiple comments as sent and emits changed once per distinct scope', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(makeComment({ id: 'a', sessionId: 'session-1', repositoryId: 'repo-1' }));
        store.add(makeComment({ id: 'b', sessionId: 'session-1', repositoryId: 'repo-1' }));
        store.add(makeComment({ id: 'c', sessionId: 'session-2', repositoryId: 'repo-1' }));
        send.mockClear();

        store.markSent(['a', 'b', 'c']);

        expect(
            store.list('session-1', 'repo-1').every((comment) => comment.status === 'sent'),
        ).toBe(true);
        expect(
            store.list('session-2', 'repo-1').every((comment) => comment.status === 'sent'),
        ).toBe(true);
        expect(send).toHaveBeenCalledTimes(2);
    });

    it('ignores unknown ids passed to markSent', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);

        store.markSent(['missing']);

        expect(send).not.toHaveBeenCalled();
    });

    it('clears sent and outdated comments but keeps pending ones', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(makeComment({ id: 'pending', status: 'pending' }));
        store.add(makeComment({ id: 'sent', status: 'pending' }));
        store.markSent(['sent']);
        store.add(makeComment({ id: 'outdated', status: 'pending', path: 'src/other.ts' }));
        store.refresh(
            'session-1',
            'repo-1',
            'working',
            'src/other.ts',
            'modified',
            'changed\ncontent',
        );
        send.mockClear();

        store.clearResolved('session-1', 'repo-1');

        const remaining = store.list('session-1', 'repo-1').map((comment) => comment.id);
        expect(remaining).toEqual(['pending']);
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('does not emit changed from clearResolved when nothing was removed', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(makeComment({ id: 'pending', status: 'pending' }));
        send.mockClear();

        store.clearResolved('session-1', 'repo-1');

        expect(send).not.toHaveBeenCalled();
    });

    it('marks a comment outdated when its anchored snippet no longer matches', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(
            makeComment({
                id: 'a',
                sourceKey: 'working',
                path: 'src/example.ts',
                side: 'modified',
                startLine: 2,
                endLine: 3,
                snippet: 'second\nthird',
            }),
        );
        send.mockClear();

        store.refresh(
            'session-1',
            'repo-1',
            'working',
            'src/example.ts',
            'modified',
            'first\nCHANGED\nCHANGED2\nfourth',
        );

        expect(store.list('session-1', 'repo-1')[0]).toMatchObject({ status: 'outdated' });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('leaves a comment pending when its anchored snippet still matches', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(
            makeComment({
                id: 'a',
                sourceKey: 'working',
                path: 'src/example.ts',
                side: 'modified',
                startLine: 2,
                endLine: 3,
                snippet: 'second\nthird',
            }),
        );
        send.mockClear();

        store.refresh(
            'session-1',
            'repo-1',
            'working',
            'src/example.ts',
            'modified',
            'first\nsecond\nthird\nfourth',
        );

        expect(store.list('session-1', 'repo-1')[0]).toMatchObject({ status: 'pending' });
        expect(send).not.toHaveBeenCalled();
    });

    it('does not touch a comment already resolved when refreshing', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(makeComment({ id: 'a', status: 'sent' }));
        send.mockClear();

        store.refresh(
            'session-1',
            'repo-1',
            'working',
            'src/example.ts',
            'modified',
            'anything else',
        );

        expect(store.list('session-1', 'repo-1')[0]).toMatchObject({ status: 'sent' });
        expect(send).not.toHaveBeenCalled();
    });

    it('keeps the same path in separate diff sources independent when refreshing', () => {
        const send = vi.fn();
        const store = new GitReviewCommentStore(send);
        store.add(
            makeComment({
                id: 'working',
                sourceKey: 'working',
                path: 'src/example.ts',
                side: 'modified',
                startLine: 2,
                endLine: 3,
                snippet: 'second\nthird',
            }),
        );
        store.add(
            makeComment({
                id: 'staged',
                sourceKey: 'staged',
                path: 'src/example.ts',
                side: 'modified',
                startLine: 2,
                endLine: 3,
                snippet: 'second\nthird',
            }),
        );
        send.mockClear();

        store.refresh(
            'session-1',
            'repo-1',
            'working',
            'src/example.ts',
            'modified',
            'CHANGED\nCHANGED2',
        );

        const comments = store.list('session-1', 'repo-1');
        expect(comments.find((comment) => comment.id === 'working')).toMatchObject({
            status: 'outdated',
        });
        expect(comments.find((comment) => comment.id === 'staged')).toMatchObject({
            status: 'pending',
        });
    });

    it('groups pending counts by Session and repository', () => {
        const store = new GitReviewCommentStore(vi.fn());
        store.add(makeComment({ id: 'a', sessionId: 'session-1', repositoryId: 'repo-1' }));
        store.add(makeComment({ id: 'b', sessionId: 'session-1', repositoryId: 'repo-1' }));
        store.add(
            makeComment({
                id: 'c',
                sessionId: 'session-2',
                repositoryId: 'repo-1',
                status: 'sent',
            }),
        );

        expect(store.pendingCounts()).toEqual([
            { sessionId: 'session-1', repositoryId: 'repo-1', count: 2 },
        ]);
    });
});

describe('gitReview.* handlers', () => {
    it('supplies empty text and pending status when adding a comment', () => {
        const store = new GitReviewCommentStore(vi.fn());
        const handlers = createGitReviewCommentHandlers(store, {
            repositoryIdentity: vi.fn(),
        });

        const result = handlers['gitReview.add']({
            id: 'a',
            sessionId: 'session-1',
            repositoryId: 'repo-1',
            sourceKey: 'working',
            path: 'src/example.ts',
            side: 'modified',
            startLine: 1,
            endLine: 1,
            snippet: 'line',
        });

        expect(result).toMatchObject({ id: 'a', text: '', status: 'pending' });
    });

    it('enriches pending groups with the repository name', async () => {
        const store = new GitReviewCommentStore(vi.fn());
        store.add(makeComment({ id: 'a' }));
        const repoIdentity = vi.fn().mockResolvedValue({ name: 'my-repo', rootPath: '/repo' });
        const handlers = createGitReviewCommentHandlers(store, {
            repositoryIdentity: repoIdentity,
        });

        const summary = await handlers['gitReview.pending']({});

        expect(summary).toEqual({
            count: 1,
            groups: [
                {
                    sessionId: 'session-1',
                    repositoryId: 'repo-1',
                    repositoryName: 'my-repo',
                    count: 1,
                },
            ],
        });
    });

    it('falls back to the repository id when identity lookup fails', async () => {
        const store = new GitReviewCommentStore(vi.fn());
        store.add(makeComment({ id: 'a' }));
        const repoIdentity = vi.fn().mockRejectedValue(new Error('not found'));
        const handlers = createGitReviewCommentHandlers(store, {
            repositoryIdentity: repoIdentity,
        });

        const summary = await handlers['gitReview.pending']({});

        expect(summary.groups[0]).toMatchObject({ repositoryName: 'repo-1' });
    });
});

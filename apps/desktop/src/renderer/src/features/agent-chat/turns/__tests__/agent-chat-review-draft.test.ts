import { describe, expect, it } from 'vitest';

import { readAgentChatEdit, writeAgentChatEdit } from '../../composer/agent-chat-edit';
import {
    readAgentChatDraft,
    subscribeAgentChatDraftChanges,
    writeAgentChatDraft,
} from '../../composer-input/agent-chat-drafts';
import {
    draftWithoutReviewComment,
    draftWithReplacedReviewComment,
    hasDraftReviewComment,
    pendingReviewCommentFlags,
    removeAgentChatReviewCommentWithUndo,
    replaceAgentChatReviewComment,
    restoreRemovedReviewComment,
    reviewCommentRestoreUnavailableReason,
} from '../agent-chat-review-draft';

describe('review comment draft sync', () => {
    it('finds a comment only while its paragraph is still in the draft', () => {
        expect(hasDraftReviewComment('intro\n\ncomment A', 'comment A')).toBe(true);
        expect(hasDraftReviewComment('intro', 'comment A')).toBe(false);
        expect(hasDraftReviewComment('anything', '')).toBe(false);
    });

    it('flags each comment still pending, once per occurrence of identical paragraphs', () => {
        expect(pendingReviewCommentFlags('a\n\nb', ['a', 'b', 'c'])).toEqual([true, true, false]);
        expect(pendingReviewCommentFlags('same', ['same', 'same'])).toEqual([true, false]);
        expect(pendingReviewCommentFlags('', ['a'])).toEqual([false]);
    });

    it('rewrites a comment in place and leaves the rest of the message alone', () => {
        expect(draftWithReplacedReviewComment('hi\n\nold\n\nbye', 'old', 'new')).toBe(
            'hi\n\nnew\n\nbye',
        );
        expect(draftWithReplacedReviewComment('hi', 'old', 'new')).toBe('hi');
    });

    it('removes a comment with its separating blank line', () => {
        expect(draftWithoutReviewComment('hi\n\nold\n\nbye', 'old')).toBe('hi\n\nbye');
        expect(draftWithoutReviewComment('hi\n\nold', 'old')).toBe('hi');
        expect(draftWithoutReviewComment('old', 'old')).toBe('');
        expect(draftWithoutReviewComment('hi', 'old')).toBe('hi');
    });

    it('edits the stored draft and the comments an Edit from here would put back on Cancel', () => {
        writeAgentChatDraft('chat-sync', 'typed\n\ncomment');
        writeAgentChatEdit('chat-sync', {
            itemId: 'm1',
            restoreFiles: false,
            previousDraft: '',
            appendedDraft: 'comment',
        });
        replaceAgentChatReviewComment('chat-sync', 'comment', 'comment v2');
        expect(readAgentChatDraft('chat-sync')).toBe('typed\n\ncomment v2');
        expect(readAgentChatEdit('chat-sync')?.appendedDraft).toBe('comment v2');
    });

    it('removes a comment and puts it back with Undo, once', () => {
        writeAgentChatDraft('chat-undo', 'typed\n\ncomment');
        const seen: string[] = [];
        const unsubscribe = subscribeAgentChatDraftChanges('chat-undo', () =>
            seen.push(readAgentChatDraft('chat-undo')),
        );
        const restoreId = removeAgentChatReviewCommentWithUndo('chat-undo', 'comment');
        expect(readAgentChatDraft('chat-undo')).toBe('typed');
        expect(reviewCommentRestoreUnavailableReason({ restoreId })).toBeUndefined();
        restoreRemovedReviewComment({ restoreId });
        expect(readAgentChatDraft('chat-undo')).toBe('typed\n\ncomment');
        expect(seen).toEqual(['typed', 'typed\n\ncomment']);
        unsubscribe();
        expect(reviewCommentRestoreUnavailableReason({ restoreId })).toBeTypeOf('string');
        restoreRemovedReviewComment({ restoreId });
        expect(readAgentChatDraft('chat-undo')).toBe('typed\n\ncomment');
    });
});

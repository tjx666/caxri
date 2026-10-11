import { describe, expect, it } from 'vitest';

import { agentChatMentionAt } from '../agent-chat-suggestions';

describe('agentChatMentionAt', () => {
    it('finds the @ word that ends at the caret', () => {
        expect(agentChatMentionAt('see @log', 8)).toEqual({ start: 4, end: 8, query: 'log' });
        expect(agentChatMentionAt('@', 1)).toEqual({ start: 0, end: 1, query: '' });
        expect(agentChatMentionAt('line one\n@plan', 14)).toEqual({
            start: 9,
            end: 14,
            query: 'plan',
        });
    });

    it('ignores a word without a leading @, an email address, and a caret past a space', () => {
        expect(agentChatMentionAt('mail me@example.com', 19)).toBeUndefined();
        expect(agentChatMentionAt('@a@b', 4)).toBeUndefined();
        expect(agentChatMentionAt('@log done', 9)).toBeUndefined();
        expect(agentChatMentionAt('@log ', 5)).toBeUndefined();
    });
});

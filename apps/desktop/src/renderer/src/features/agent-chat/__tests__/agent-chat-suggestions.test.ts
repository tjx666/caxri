import { describe, expect, it } from 'vitest';

import {
    agentChatMentionAt,
    agentChatSessionEmptyText,
    agentChatSessionPreparingText,
    agentChatSessionSuggestions,
    agentChatSuggestionFooter,
} from '../agent-chat-suggestions';

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

describe('agentChatSessionSuggestions', () => {
    it('names each Project, and adds when it was opened only to titles that repeat', () => {
        const suggestions = agentChatSessionSuggestions(
            [
                { sessionId: 'a', title: 'Fix login', projectTitle: 'web' },
                { sessionId: 'b', title: 'fix login', projectTitle: 'web' },
                { sessionId: 'c', title: 'Release', projectTitle: undefined },
            ],
            new Map([
                ['a', 100],
                ['b', 200],
                ['c', 300],
            ]),
        );
        expect(suggestions).toEqual([
            {
                key: 'session-a',
                label: 'Fix login',
                isLabelLiteral: false,
                description: 'web',
                openedAt: 100,
            },
            {
                key: 'session-b',
                label: 'fix login',
                isLabelLiteral: false,
                description: 'web',
                openedAt: 200,
            },
            { key: 'session-c', label: 'Release', isLabelLiteral: false },
        ]);
    });
});

describe('Agent Chat suggestion list copy', () => {
    it('names Escape in every footer and Enter only when a row can be chosen', () => {
        expect(agentChatSuggestionFooter('commands', true)).toBe(
            '↑↓ to move · Tab to complete · Enter to run · Esc to dismiss',
        );
        expect(agentChatSuggestionFooter('sessions', true)).toBe(
            '↑↓ to move · Enter to cite · Esc to dismiss',
        );
        expect(agentChatSuggestionFooter('commands', false)).toBe('Esc to dismiss');
        expect(agentChatSuggestionFooter('sessions', false)).toBe('Esc to dismiss');
    });

    it('explains an empty @ list and the reference being prepared', () => {
        expect(agentChatSessionEmptyText('relese')).toBe('No Sessions match');
        expect(agentChatSessionEmptyText('')).toBe('No other Sessions to cite');
        expect(agentChatSessionPreparingText('Fix login')).toBe('Preparing “Fix login”…');
    });
});

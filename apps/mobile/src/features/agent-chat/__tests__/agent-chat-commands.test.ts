import { describe, expect, it } from 'vitest';

import {
    agentChatCommandChoice,
    agentChatCommandSuggestions,
    MOBILE_AGENT_CHAT_COMMAND_ROWS,
} from '../agent-chat-commands';

const commands = [
    { name: 'compact', description: 'Summarize the conversation' },
    { name: 'review', argumentHint: '<path>' },
    { name: 'mcp:list' },
];

describe('agentChatCommandSuggestions', () => {
    it('lists every command for a bare slash and narrows by name while the user types', () => {
        expect(agentChatCommandSuggestions('/', commands)?.map(({ name }) => name)).toEqual([
            'compact',
            'review',
            'mcp:list',
        ]);
        expect(agentChatCommandSuggestions('/REV', commands)?.map(({ name }) => name)).toEqual([
            'review',
        ]);
        expect(agentChatCommandSuggestions('/mcp:', commands)?.map(({ name }) => name)).toEqual([
            'mcp:list',
        ]);
    });

    it('shows no list mid-sentence, past the name, for skills, without matches, or without commands', () => {
        expect(agentChatCommandSuggestions('fix /rev', commands)).toBeUndefined();
        expect(agentChatCommandSuggestions('/review src', commands)).toBeUndefined();
        expect(agentChatCommandSuggestions('$review', commands)).toBeUndefined();
        expect(agentChatCommandSuggestions('/zzz', commands)).toBeUndefined();
        expect(agentChatCommandSuggestions('/', [])).toBeUndefined();
        expect(agentChatCommandSuggestions('/', undefined)).toBeUndefined();
    });

    it('caps the list so it fits above the keyboard', () => {
        const many = Array.from({ length: 20 }, (_, index) => ({ name: `c${index}` }));
        expect(agentChatCommandSuggestions('/', many)).toHaveLength(MOBILE_AGENT_CHAT_COMMAND_ROWS);
    });
});

describe('agentChatCommandChoice', () => {
    it('runs a command without arguments and completes one that takes them', () => {
        expect(agentChatCommandChoice(commands[0])).toEqual({
            kind: 'run',
            command: { name: 'compact' },
        });
        expect(agentChatCommandChoice(commands[1])).toEqual({
            kind: 'complete',
            draft: '/review ',
        });
    });
});

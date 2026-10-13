import { describe, expect, it } from 'vitest';

import {
    agentChatCommandChoice,
    agentChatCommandMenu,
    MOBILE_AGENT_CHAT_COMMAND_ROWS,
    shouldHoldAgentChatSendAsText,
} from '../agent-chat-commands';

const commands = [
    { name: 'compact', description: 'Summarize the conversation' },
    { name: 'review', argumentHint: '<path>' },
    { name: 'mcp:list' },
];

const names = (draft: string, list = commands) =>
    agentChatCommandMenu(draft, list)?.matches.map(({ name }) => name);

describe('agentChatCommandMenu', () => {
    it('lists every command for a bare slash and narrows by name while the user types', () => {
        expect(names('/')).toEqual(['compact', 'review', 'mcp:list']);
        expect(names('/REV')).toEqual(['review']);
        expect(names('/mcp:')).toEqual(['mcp:list']);
    });

    it('shows no list mid-sentence, past the name, for skills, or without commands', () => {
        expect(agentChatCommandMenu('fix /rev', commands)).toBeUndefined();
        expect(agentChatCommandMenu('/review src', commands)).toBeUndefined();
        expect(agentChatCommandMenu('$review', commands)).toBeUndefined();
        expect(agentChatCommandMenu('/', [])).toBeUndefined();
        expect(agentChatCommandMenu('/', undefined)).toBeUndefined();
    });

    it('keeps the list open with no matches so a typo reads as a miss', () => {
        expect(agentChatCommandMenu('/zzz', commands)).toEqual({ matches: [], hasMore: false });
    });

    it('caps the list so it fits above the keyboard and says more are hidden', () => {
        const many = Array.from({ length: 20 }, (_, index) => ({ name: `c${index}` }));
        const menu = agentChatCommandMenu('/', many);
        expect(menu?.matches).toHaveLength(MOBILE_AGENT_CHAT_COMMAND_ROWS);
        expect(menu?.hasMore).toBe(true);
        const exact = many.slice(0, MOBILE_AGENT_CHAT_COMMAND_ROWS);
        expect(agentChatCommandMenu('/', exact)?.hasMore).toBe(false);
    });
});

describe('shouldHoldAgentChatSendAsText', () => {
    it('holds the first send of an unknown command and lets the second through', () => {
        expect(
            shouldHoldAgentChatSendAsText({ commands, confirmedDraft: undefined, draft: '/zzz' }),
        ).toBe(true);
        expect(
            shouldHoldAgentChatSendAsText({ commands, confirmedDraft: '/zzz', draft: '/zzz' }),
        ).toBe(false);
        expect(
            shouldHoldAgentChatSendAsText({ commands, confirmedDraft: '/zz', draft: '/zzz' }),
        ).toBe(true);
    });

    it('never holds a listed command, ordinary text, or a provider without commands', () => {
        expect(
            shouldHoldAgentChatSendAsText({
                commands,
                confirmedDraft: undefined,
                draft: '/compact',
            }),
        ).toBe(false);
        expect(
            shouldHoldAgentChatSendAsText({ commands, confirmedDraft: undefined, draft: 'hello' }),
        ).toBe(false);
        expect(
            shouldHoldAgentChatSendAsText({
                commands,
                confirmedDraft: undefined,
                draft: '/zzz now',
            }),
        ).toBe(false);
        expect(
            shouldHoldAgentChatSendAsText({
                commands: [],
                confirmedDraft: undefined,
                draft: '/zzz',
            }),
        ).toBe(false);
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

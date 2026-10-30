import type { AgentChatItem, AgentChatRequest, TerminalRecord } from '@caxri/protocol';
import {
    AGENT_CHAT_WAITING_MAX_CHATS,
    AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH,
    agentChatProposedPlanRequest,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { WaitingChatSource } from '../waiting/chat-waiting';
import { readWaitingChats, readWaitingTerminals } from '../waiting/chat-waiting';

const approval: AgentChatRequest = {
    id: 'request-1',
    kind: 'command',
    command: 'rm -rf build',
    decisions: ['accept', 'decline'],
};

function source(
    terminalId: string,
    overrides: Partial<WaitingChatSource> & { items?: AgentChatItem[] } = {},
): WaitingChatSource {
    const { items = [], ...rest } = overrides;
    return { terminalId, snapshot: { items, requests: [approval] }, isOpen: true, ...rest };
}

const sessionOf = (terminalId: string): string | undefined => `session-of-${terminalId}`;

describe('readWaitingChats', () => {
    it('lists each live Chat with requests under its Session, in the given order', () => {
        expect(readWaitingChats([source('b'), source('a')], sessionOf)).toEqual([
            { kind: 'chat', sessionId: 'session-of-b', terminalId: 'b', requests: [approval] },
            { kind: 'chat', sessionId: 'session-of-a', terminalId: 'a', requests: [approval] },
        ]);
    });

    it('skips a Chat whose provider is gone instead of reopening it, one with nothing to ask, and an unknown Terminal', () => {
        const closed = source('closed', { isOpen: false });
        const idle = source('idle', { snapshot: { items: [], requests: [] } });
        expect(
            readWaitingChats([closed, idle, source('gone')], (terminalId) =>
                terminalId === 'gone' ? undefined : sessionOf(terminalId),
            ),
        ).toEqual([]);
    });

    it('quotes the latest message the user typed, not a delegated task pointer or a blank one', () => {
        const items: AgentChatItem[] = [
            { id: 'm1', type: 'userMessage', text: '  Set up CI  ' },
            {
                id: 'm2',
                type: 'userMessage',
                text: 'Task pointer',
                delegatedTask: { delegationId: 'delegation-1' },
            },
            { id: 'm3', type: 'userMessage', text: ' '.repeat(3) },
        ];
        expect(readWaitingChats([source('a', { items })], sessionOf)[0]?.prompt).toBe('Set up CI');
    });

    it('clips the quoted message and caps how many Chats it lists', () => {
        const items: AgentChatItem[] = [
            {
                id: 'm1',
                type: 'userMessage',
                text: 'x'.repeat(AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH * 2),
            },
        ];
        const many = Array.from({ length: AGENT_CHAT_WAITING_MAX_CHATS + 5 }, (_, index) =>
            source(`t${index}`, { items }),
        );
        const chats = readWaitingChats(many, sessionOf);
        expect(chats).toHaveLength(AGENT_CHAT_WAITING_MAX_CHATS);
        expect(chats[0]?.prompt).toHaveLength(AGENT_CHAT_WAITING_PROMPT_MAX_LENGTH);
    });
});

describe('readWaitingChats proposed plans', () => {
    const plan: AgentChatItem = {
        id: 'plan-1',
        type: 'agentMessage',
        text: 'Step one',
        streaming: false,
        proposedPlan: true,
    };
    const planned = (overrides: Partial<WaitingChatSource['snapshot']> = {}) =>
        source('a', {
            snapshot: { items: [plan], requests: [], planMode: true, ...overrides },
        });

    it('lists a finished proposed plan awaiting approval as a request of its Chat', () => {
        expect(readWaitingChats([planned()], sessionOf)[0]?.requests).toEqual([
            agentChatProposedPlanRequest('plan-1'),
        ]);
    });

    it('lists it after the Chat real requests and drops it once the plan is stale', () => {
        const withApproval = planned({ requests: [approval] });
        expect(readWaitingChats([withApproval], sessionOf)[0]?.requests).toEqual([
            approval,
            agentChatProposedPlanRequest('plan-1'),
        ]);
        for (const stale of [
            { planMode: false },
            { activeTurnId: 'turn-2' },
            { items: [plan, { id: 'u', type: 'userMessage' as const, text: 'More' }] },
        ])
            expect(readWaitingChats([planned(stale)], sessionOf)).toEqual([]);
    });
});

describe('readWaitingTerminals', () => {
    const waiting = { agentActivityState: 'waiting', primaryAgentTerminalId: 't1' } as const;
    const pty = { lastAgentProcessState: 'running' } as const;

    it('lists the Primary Agent Terminal of each Session waiting on the user', () => {
        expect(
            readWaitingTerminals(
                [
                    { id: 's1', ...waiting },
                    { id: 's2', ...waiting, primaryAgentTerminalId: 't2' },
                    { id: 's3', ...waiting, agentActivityState: 'running' },
                    { id: 's4', ...waiting, agentActivityState: 'completed' },
                ],
                () => pty,
            ),
        ).toEqual([
            { kind: 'terminal', sessionId: 's1', terminalId: 't1' },
            { kind: 'terminal', sessionId: 's2', terminalId: 't2' },
        ]);
    });

    it('skips a Chat Terminal, an Agent that is no longer running, an archived Session, and a missing Terminal', () => {
        const terminals: Record<
            string,
            Pick<TerminalRecord, 'lastAgentProcessState' | 'surface'>
        > = {
            chat: { ...pty, surface: 'chat' },
            exited: { lastAgentProcessState: 'stopped' },
            archived: pty,
        };
        expect(
            readWaitingTerminals(
                [
                    { id: 'a', ...waiting, primaryAgentTerminalId: 'chat' },
                    { id: 'b', ...waiting, primaryAgentTerminalId: 'exited' },
                    { id: 'c', ...waiting, primaryAgentTerminalId: 'archived', archivedAt: 1 },
                    { id: 'd', ...waiting, primaryAgentTerminalId: 'missing' },
                    { id: 'e', agentActivityState: 'waiting' },
                ],
                (terminalId) => terminals[terminalId],
            ),
        ).toEqual([]);
    });
});

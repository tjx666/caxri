import type { AgentChatSnapshot } from '@caxri/protocol';
import { emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatEmptyMessage, isAgentChatConversationLoading } from '../agent-chat-presentation';

function snapshot(status: AgentChatSnapshot['status']): AgentChatSnapshot {
    return { ...emptyAgentChatSnapshot('terminal-1'), status };
}

describe('agentChatEmptyMessage', () => {
    it('invites the first message only once an empty Chat is ready', () => {
        expect(agentChatEmptyMessage(snapshot('ready'), 'running', 'Codex')).toBe(
            'Send a message to start working with Codex.',
        );
        expect(agentChatEmptyMessage(snapshot('starting'), 'starting', 'Codex')).toBeUndefined();
        expect(agentChatEmptyMessage(undefined, 'running', 'Codex')).toBeUndefined();
    });

    it('explains the blank transcript of a Chat handed to another client', () => {
        expect(agentChatEmptyMessage(snapshot('stopped'), 'detached', 'Codex')).toBe(
            'Messages appear here once the Chat resumes.',
        );
    });

    it('stays out of a transcript that has messages', () => {
        const withItem: AgentChatSnapshot = {
            ...snapshot('stopped'),
            items: [{ id: 'item-1', type: 'userMessage', text: 'hello' }],
        };
        expect(agentChatEmptyMessage(withItem, 'detached', 'Codex')).toBeUndefined();
    });
});

describe('isAgentChatConversationLoading', () => {
    const resumed = { hasConversation: true, isPending: false };

    it('loads a resumed conversation while its first read is pending', () => {
        expect(
            isAgentChatConversationLoading(undefined, { hasConversation: true, isPending: true }),
        ).toBe(true);
    });

    it('keeps loading while the resumed provider starts and has not replayed its history', () => {
        expect(isAgentChatConversationLoading(snapshot('starting'), resumed)).toBe(true);
    });

    it('stops once the history arrives or the provider is ready', () => {
        const withItem: AgentChatSnapshot = {
            ...snapshot('starting'),
            items: [{ id: 'item-1', type: 'userMessage', text: 'hello' }],
        };
        expect(isAgentChatConversationLoading(withItem, resumed)).toBe(false);
        expect(isAgentChatConversationLoading(snapshot('ready'), resumed)).toBe(false);
        expect(isAgentChatConversationLoading(undefined, resumed)).toBe(false);
    });

    it('never loads a Chat without an Agent Session', () => {
        const fresh = { hasConversation: false, isPending: true };
        expect(isAgentChatConversationLoading(undefined, fresh)).toBe(false);
        expect(isAgentChatConversationLoading(snapshot('starting'), fresh)).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';

import type { AgentChatItem, AgentChatSnapshot } from '../agent-chat-contract';
import { emptyAgentChatSnapshot } from '../agent-chat-reducer';
import { agentChatRewindableMessageIds, agentChatRewindTarget } from '../agent-chat-rewind';

function user(id: string, turnId: string, delivery?: 'steered'): AgentChatItem {
    return { id, type: 'userMessage', text: id, turnId, ...(delivery && { delivery }) };
}

function chat(items: AgentChatItem[], activeTurnId?: string): AgentChatSnapshot {
    const turnIds = [...new Set(items.flatMap((item) => (item.turnId ? [item.turnId] : [])))];
    return {
        ...emptyAgentChatSnapshot('terminal-1'),
        items,
        turns: turnIds.map((id) => ({
            id,
            status: id === activeTurnId ? ('running' as const) : ('completed' as const),
        })),
        ...(activeTurnId && { activeTurnId }),
    };
}

describe('Agent Chat rewind target', () => {
    const snapshot = chat([
        user('u1', 't1'),
        { id: 'a1', type: 'agentMessage', text: 'ok', streaming: false, turnId: 't1' },
        user('u2', 't2'),
        user('steer', 't2', 'steered'),
        user('u3', 't3'),
    ]);

    it('removes the message turn and every later one', () => {
        expect(agentChatRewindTarget(snapshot, 'u2')).toEqual({
            target: { itemId: 'u2', turnId: 't2', keptTurns: 1, removedTurns: 2 },
        });
        expect(agentChatRewindTarget(snapshot, 'u1')).toMatchObject({
            target: { keptTurns: 0, removedTurns: 3 },
        });
    });

    it('refuses a steered message, a reply, and an unknown id', () => {
        expect(agentChatRewindTarget(snapshot, 'steer')).toEqual({ refusal: 'notTurnStart' });
        expect(agentChatRewindTarget(snapshot, 'a1')).toEqual({ refusal: 'unknownMessage' });
        expect(agentChatRewindTarget(snapshot, 'gone')).toEqual({ refusal: 'unknownMessage' });
    });

    it('refuses while a turn runs but keeps offering the action', () => {
        const running = chat([user('u1', 't1'), user('u2', 't2')], 't2');
        expect(agentChatRewindTarget(running, 'u1')).toEqual({ refusal: 'turnRunning' });
        expect(agentChatRewindTarget({ ...snapshot, operation: 'compacting' }, 'u1')).toEqual({
            refusal: 'turnRunning',
        });
        expect(agentChatRewindableMessageIds(running)).toEqual(new Set(['u1', 'u2']));
    });

    it('offers only messages that start a known turn', () => {
        expect(agentChatRewindableMessageIds(snapshot)).toEqual(new Set(['u1', 'u2', 'u3']));
    });
});

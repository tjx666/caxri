import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    parseAgentChatEditAvailability,
    serializeAgentChatEditAvailability,
} from '../composer/agent-chat-edit';

const user = (id: string, turnId: string): AgentChatItem => ({
    id,
    turnId,
    type: 'userMessage',
    text: 'hi',
});
const reply = (id: string, turnId: string, text: string): AgentChatItem => ({
    id,
    turnId,
    type: 'agentMessage',
    text,
    streaming: true,
});

describe('edit availability table', () => {
    const turns = [
        { id: 't1', status: 'completed' as const },
        { id: 't2', status: 'running' as const },
    ];

    it('serializes identically across streamed deltas of the running turn', () => {
        const snapshot = (text: string) => ({
            activeTurnId: 't2',
            turns,
            items: [
                user('u1', 't1'),
                reply('r1', 't1', 'x'),
                user('u2', 't2'),
                reply('r2', 't2', text),
            ],
        });
        expect(serializeAgentChatEditAvailability(snapshot('a'))).toBe(
            serializeAgentChatEditAvailability(snapshot('ab')),
        );
    });

    it('lists only rewindable user messages and explains a running turn', () => {
        const table = parseAgentChatEditAvailability(
            serializeAgentChatEditAvailability({
                activeTurnId: 't2',
                turns,
                items: [user('u1', 't1'), user('u2', 't2')],
            }),
        );
        expect(table.has('missing')).toBe(false);
        expect(table.keys().toArray()).toEqual(['u1', 'u2']);
        expect(typeof table.get('u1')?.edit).toBe('string');
    });
});

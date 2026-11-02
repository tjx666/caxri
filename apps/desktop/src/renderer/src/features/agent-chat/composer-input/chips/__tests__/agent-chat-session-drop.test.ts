import { describe, expect, it } from 'vitest';

import { agentChatComposerDragKind, agentChatSessionDropVerdict } from '../agent-chat-session-drop';

describe('agentChatSessionDropVerdict', () => {
    const other = { id: 'b', primaryAgentTerminalId: 't' };

    it('allows another Session with an Agent conversation', () => {
        expect(agentChatSessionDropVerdict(other, 'a', 'b')).toBe('ok');
    });

    it('names the Chat own Session even when it is otherwise referenceable', () => {
        expect(
            agentChatSessionDropVerdict({ id: 'a', primaryAgentTerminalId: 't' }, 'a', 'a'),
        ).toBe('self');
    });

    it('refuses unknown, archived, and Agent-less Sessions as unavailable', () => {
        expect(agentChatSessionDropVerdict(undefined, 'a', 'b')).toBe('unavailable');
        expect(agentChatSessionDropVerdict({ ...other, archivedAt: 1 }, 'a', 'b')).toBe(
            'unavailable',
        );
        expect(agentChatSessionDropVerdict({ id: 'b' }, 'a', 'b')).toBe('unavailable');
    });
});

describe('agentChatComposerDragKind', () => {
    it('maps verdicts to session or refusal kinds without consulting paths', () => {
        const isNotConsulted = (): boolean => {
            throw new Error('unexpected');
        };
        expect(agentChatComposerDragKind({ id: 'b', verdict: 'ok' }, isNotConsulted)).toBe(
            'session',
        );
        expect(agentChatComposerDragKind({ id: 'a', verdict: 'self' }, isNotConsulted)).toBe(
            'refused-self',
        );
        expect(agentChatComposerDragKind({ id: 'a', verdict: 'unavailable' }, isNotConsulted)).toBe(
            'refused-unavailable',
        );
    });

    it('falls back to paths, or nothing', () => {
        expect(agentChatComposerDragKind(undefined, () => true)).toBe('paths');
        expect(agentChatComposerDragKind(undefined, () => false)).toBeUndefined();
    });
});

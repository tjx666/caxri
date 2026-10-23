import { describe, expect, it } from 'vitest';

import { agentChatSessionHandoffTarget } from '../agent-chat-session-handoff-target';

const session = (id: string, createdAt: number, createdBySessionId?: string) => ({
    id,
    createdAt,
    createdBySessionId,
});

describe('agentChatSessionHandoffTarget', () => {
    const sessions = [
        session('earlier', 50, 'source'),
        session('other-creator', 120, 'elsewhere'),
        session('later', 300, 'source'),
        session('handoff', 150, 'source'),
        session('user-made', 110),
    ];

    it('picks the first Session the source created at or after the message', () => {
        expect(agentChatSessionHandoffTarget(sessions, 'source', 100)?.id).toBe('handoff');
        expect(agentChatSessionHandoffTarget(sessions, 'source', 150)?.id).toBe('handoff');
    });

    it('finds nothing before the Agent created it or without a send time', () => {
        expect(agentChatSessionHandoffTarget(sessions, 'source', 400)).toBeUndefined();
        expect(agentChatSessionHandoffTarget(sessions, 'source', undefined)).toBeUndefined();
        expect(agentChatSessionHandoffTarget(sessions, undefined, 100)).toBeUndefined();
        expect(agentChatSessionHandoffTarget(undefined, 'source', 100)).toBeUndefined();
    });
});

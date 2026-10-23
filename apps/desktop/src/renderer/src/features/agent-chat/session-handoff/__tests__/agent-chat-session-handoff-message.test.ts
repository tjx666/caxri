import { parseAgentChatSessionHandoff } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatSessionHandoffMessage } from '../agent-chat-session-handoff-message';

const sessions = [{ id: 'session-1', projectId: 'project-1' }];
const terminal = { kind: 'claude', provider: 'claude', sessionId: 'session-1' } as const;

describe('agentChatSessionHandoffMessage', () => {
    it('sends /new-session as hand-off instructions naming the Chat Project and provider', () => {
        const text = agentChatSessionHandoffMessage(
            '/new-session write the docs',
            terminal,
            sessions,
        );
        expect(parseAgentChatSessionHandoff(text)).toEqual({ note: 'write the docs' });
        expect(text).toContain('--project project-1');
        expect(text).toContain('--provider claude');
        const codex = agentChatSessionHandoffMessage(
            '/new-session',
            { kind: 'codex', provider: undefined, sessionId: 'session-1' },
            sessions,
        );
        expect(codex).toContain('--provider codex');
    });

    it('leaves other drafts, and a Chat whose Session is unknown, as typed', () => {
        expect(agentChatSessionHandoffMessage('hello', terminal, sessions)).toBe('hello');
        expect(agentChatSessionHandoffMessage('/new-session x', terminal, [])).toBe(
            '/new-session x',
        );
        expect(agentChatSessionHandoffMessage('/new-session x', undefined, sessions)).toBe(
            '/new-session x',
        );
    });
});

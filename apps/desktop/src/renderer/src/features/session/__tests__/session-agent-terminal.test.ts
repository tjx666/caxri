import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    indexedSessionAgentTerminal,
    sessionAgentTerminal,
    sessionTerminalIndex,
} from '../session-agent-terminal';

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return { id: 'session-1', ...overrides } as SessionRecord;
}

function terminal(id: string, sessionId: string): TerminalRecord {
    return { id, sessionId } as TerminalRecord;
}

describe('sessionAgentTerminal', () => {
    it('prefers the Primary Agent Terminal', () => {
        const primary = terminal('terminal-2', 'session-1');
        expect(
            sessionAgentTerminal(session({ primaryAgentTerminalId: 'terminal-2' }), [
                terminal('terminal-1', 'session-1'),
                primary,
            ]),
        ).toBe(primary);
    });

    it('falls back to the Session’s first Terminal when no Primary Agent is bound', () => {
        const first = terminal('terminal-1', 'session-1');
        expect(sessionAgentTerminal(session(), [first, terminal('terminal-2', 'session-1')])).toBe(
            first,
        );
    });

    /**
     * The whole reason the Primary Agent lookup is scoped to the Session's own Terminals. A stale
     * `primaryAgentTerminalId` pointing at a Terminal that now belongs to another Session must not resolve, or the
     * Session's status glyph would describe a different Session's Agent.
     */
    it('ignores a Primary Agent id that points outside the Session', () => {
        const own = terminal('terminal-1', 'session-1');
        expect(
            sessionAgentTerminal(session({ primaryAgentTerminalId: 'terminal-9' }), [
                terminal('terminal-9', 'session-2'),
                own,
            ]),
        ).toBe(own);
    });

    it('returns undefined when the Session owns no Terminal', () => {
        expect(
            sessionAgentTerminal(session(), [terminal('terminal-9', 'session-2')]),
        ).toBeUndefined();
    });
});

describe('indexedSessionAgentTerminal', () => {
    /**
     * Interleaved on purpose: the index must keep each Session's own record order, because "first Terminal" is the
     * fallback both lookups share.
     */
    const terminals = [
        terminal('terminal-a1', 'session-a'),
        terminal('terminal-b1', 'session-b'),
        terminal('terminal-a2', 'session-a'),
        terminal('terminal-c1', 'session-c'),
        terminal('terminal-b2', 'session-b'),
    ];
    const sessions = [
        // Primary Agent bound to its own second Terminal.
        session({ id: 'session-a', primaryAgentTerminalId: 'terminal-a2' }),
        // Primary Agent id pointing at another Session's Terminal: must fall back to this Session's first.
        session({ id: 'session-b', primaryAgentTerminalId: 'terminal-c1' }),
        // No Primary Agent: first Terminal.
        session({ id: 'session-c' }),
        // Primary Agent id naming a Terminal that no longer exists.
        session({ id: 'session-d', primaryAgentTerminalId: 'terminal-gone' }),
        // No Terminal at all.
        session({ id: 'session-e' }),
    ];

    it('picks the same Terminal as sessionAgentTerminal for every Session', () => {
        const index = sessionTerminalIndex(terminals);
        for (const item of sessions)
            expect(indexedSessionAgentTerminal(item, index), item.id).toBe(
                sessionAgentTerminal(item, terminals),
            );
    });

    it('prefers the Primary Agent and ignores one that belongs to another Session', () => {
        const index = sessionTerminalIndex(terminals);
        expect(indexedSessionAgentTerminal(sessions[0], index)?.id).toBe('terminal-a2');
        expect(indexedSessionAgentTerminal(sessions[1], index)?.id).toBe('terminal-b1');
        expect(indexedSessionAgentTerminal(sessions[2], index)?.id).toBe('terminal-c1');
        expect(indexedSessionAgentTerminal(sessions[3], index)).toBeUndefined();
        expect(indexedSessionAgentTerminal(sessions[4], index)).toBeUndefined();
    });
});

import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { sessionAgentTerminal } from '../session-agent-terminal';

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

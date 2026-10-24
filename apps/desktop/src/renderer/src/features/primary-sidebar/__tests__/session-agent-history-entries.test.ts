import type { SessionAgentHistoryEntry } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { reopenableConversations } from '../session-agent-history-entries';

function entry(overrides: Partial<SessionAgentHistoryEntry> = {}): SessionAgentHistoryEntry {
    return { provider: 'claude', agentSessionId: 'conversation-1', boundAt: 1_000, ...overrides };
}

describe('reopenableConversations', () => {
    it('offers only conversations without an open Terminal, in Server order', () => {
        const closedNewer = entry({ agentSessionId: 'closed-newer' });
        const closedOlder = entry({ agentSessionId: 'closed-older' });
        expect(
            reopenableConversations([
                entry({ terminalId: 'terminal-1' }),
                closedNewer,
                closedOlder,
            ]),
        ).toEqual([closedNewer, closedOlder]);
    });

    it('offers nothing while every conversation is still open', () => {
        expect(reopenableConversations([entry({ terminalId: 'terminal-1' })])).toEqual([]);
    });
});

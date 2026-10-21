import type { SessionAgentHistoryEntry } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { hasReopenableConversation } from '../session-agent-history-entries';

function entry(overrides: Partial<SessionAgentHistoryEntry> = {}): SessionAgentHistoryEntry {
    return { provider: 'claude', agentSessionId: 'conversation-1', boundAt: 1_000, ...overrides };
}

describe('hasReopenableConversation', () => {
    it('shows the history once a conversation has no open Terminal', () => {
        expect(hasReopenableConversation([entry({ terminalId: 'terminal-1' }), entry()])).toBe(
            true,
        );
    });

    it('hides it while every conversation is still open, or there are none', () => {
        expect(hasReopenableConversation([entry({ terminalId: 'terminal-1' })])).toBe(false);
        expect(hasReopenableConversation([])).toBe(false);
    });
});

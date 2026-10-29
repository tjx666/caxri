import { describe, expect, it, vi } from 'vitest';

import { handOffAgentChatFind, registerAgentChatFindHandoff } from '../agent-chat-find-handoff';

describe('Agent Chat find handoff', () => {
    it('delivers to a mounted Chat at once and to a later one only within the wait', () => {
        const mounted = vi.fn();
        const unregister = registerAgentChatFindHandoff('conversation-a', mounted, 0);
        handOffAgentChatFind('conversation-a', 'probe', 0);
        expect(mounted).toHaveBeenCalledWith('probe');
        unregister();

        handOffAgentChatFind('conversation-b', 'invoice', 1_000);
        const other = vi.fn();
        registerAgentChatFindHandoff('conversation-a', other, 1_100)();
        expect(other).not.toHaveBeenCalled();
        const late = vi.fn();
        registerAgentChatFindHandoff('conversation-b', late, 1_200)();
        expect(late).toHaveBeenCalledWith('invoice');

        handOffAgentChatFind('conversation-c', 'stale', 0);
        const expired = vi.fn();
        registerAgentChatFindHandoff('conversation-c', expired, 60_000)();
        expect(expired).not.toHaveBeenCalled();
    });
});

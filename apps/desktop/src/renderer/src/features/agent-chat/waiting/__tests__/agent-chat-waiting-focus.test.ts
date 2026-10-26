import { describe, expect, it, vi } from 'vitest';

import {
    agentChatWaitingReturnFocus,
    canFocusAgentChatWaiting,
    focusAgentChatWaiting,
    registerAgentChatWaitingFocus,
} from '../agent-chat-waiting-focus';

describe('agent chat waiting focus', () => {
    it('runs the registered handler only while it is registered', () => {
        const run = vi.fn();
        expect(canFocusAgentChatWaiting()).toBe(false);
        const unregister = registerAgentChatWaitingFocus(run);
        expect(canFocusAgentChatWaiting()).toBe(true);
        focusAgentChatWaiting();
        expect(run).toHaveBeenCalledTimes(1);
        unregister();
        expect(canFocusAgentChatWaiting()).toBe(false);
    });

    it('keeps a newer handler when an older registration is torn down late', () => {
        const older = vi.fn();
        const newer = vi.fn();
        const unregisterOlder = registerAgentChatWaitingFocus(older);
        const unregisterNewer = registerAgentChatWaitingFocus(newer);
        unregisterOlder();
        focusAgentChatWaiting();
        expect(newer).toHaveBeenCalledTimes(1);
        expect(older).not.toHaveBeenCalled();
        unregisterNewer();
    });

    it('returns focus to where the user was only while focus is lost and that element is still there', () => {
        const editor = { isConnected: true };
        expect(agentChatWaitingReturnFocus(editor, true)).toBe(editor);
        expect(agentChatWaitingReturnFocus(editor, false)).toBeUndefined();
        expect(agentChatWaitingReturnFocus({ isConnected: false }, true)).toBeUndefined();
        expect(agentChatWaitingReturnFocus(null, true)).toBeUndefined();
    });
});

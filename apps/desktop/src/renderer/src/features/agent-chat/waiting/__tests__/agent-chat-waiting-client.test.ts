import { describe, expect, it } from 'vitest';

import { isAgentChatWaitingPatch, waitingTerminalKey } from '../agent-chat-waiting-client';

describe('isAgentChatWaitingPatch', () => {
    it('re-reads the waiting list when a patch replaces requests or resets the Chat', () => {
        expect(
            isAgentChatWaitingPatch({ operations: [{ op: 'state', state: { requests: [] } }] }),
        ).toBe(true);
        expect(isAgentChatWaitingPatch({ operations: [{ op: 'reset' }] })).toBe(true);
    });

    it('re-reads it when a turn starts or ends or plan mode flips, which decides a proposed plan', () => {
        for (const state of [{ activeTurnId: 't1' }, { planMode: false }])
            expect(isAgentChatWaitingPatch({ operations: [{ op: 'state', state }] })).toBe(true);
    });

    it('ignores streamed text and state that leaves requests alone', () => {
        expect(
            isAgentChatWaitingPatch({
                operations: [
                    { op: 'appendText', itemId: 'item-1', delta: 'more' },
                    { op: 'state', state: { status: 'ready' } },
                ],
            }),
        ).toBe(false);
    });
});

describe('waitingTerminalKey', () => {
    const session = (id: string, agentActivityState: 'running' | 'waiting', terminal?: string) => ({
        id,
        agentActivityState,
        primaryAgentTerminalId: terminal,
    });

    it('changes exactly when a Session starts or stops waiting', () => {
        const running = waitingTerminalKey([session('s1', 'running', 't1')]);
        const waiting = waitingTerminalKey([session('s1', 'waiting', 't1')]);
        expect(waiting).not.toBe(running);
        expect(waitingTerminalKey([session('s1', 'waiting', 't1'), session('s2', 'running')])).toBe(
            waiting,
        );
        expect(waitingTerminalKey(undefined)).toBe('');
    });
});

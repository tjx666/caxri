import { describe, expect, it } from 'vitest';

import {
    agentChatForkSuccessMessage,
    agentChatReplaceTurnsConfirm,
    agentChatRestoreSuccessMessage,
} from '../agent-chat-rewind-copy';

describe('agentChatReplaceTurnsConfirm', () => {
    it('asks before replacing more than one turn and points at Fork', () => {
        expect(agentChatReplaceTurnsConfirm({ removedTurns: 3, restoreFiles: false })).toEqual({
            title: 'Replace 3 later turns?',
            message:
                "Sending this edit removes this message's turn and the 2 after it from the conversation. To keep them, cancel and use Fork from Here instead.",
            confirmLabel: 'Replace Turns',
        });
    });

    it('sends without asking when only the message turn is replaced', () => {
        expect(agentChatReplaceTurnsConfirm({ removedTurns: 1, restoreFiles: false })).toBe(
            undefined,
        );
    });

    it('leaves the question to the native revert dialog when files are reverted too', () => {
        expect(agentChatReplaceTurnsConfirm({ removedTurns: 4, restoreFiles: true })).toBe(
            undefined,
        );
    });
});

describe('agentChatRestoreSuccessMessage', () => {
    it('names how many turns of changes were put back', () => {
        expect(agentChatRestoreSuccessMessage(1)).toBe('Restored the code changed in 1 turn');
        expect(agentChatRestoreSuccessMessage(2)).toBe('Restored the code changed in 2 turns');
    });
});

describe('agentChatForkSuccessMessage', () => {
    it('names the new Session when it is known', () => {
        expect(agentChatForkSuccessMessage('api-fix')).toBe('Forked into a new Session: api-fix');
        expect(agentChatForkSuccessMessage('  ')).toBe('Forked into a new Session');
        expect(agentChatForkSuccessMessage(undefined)).toBe('Forked into a new Session');
    });
});

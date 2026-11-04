import type { AgentChatDelegationNotice, AgentChatPatchOperation } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { stampDelegationNotices } from '../delegation-notices';

const NOTICE: AgentChatDelegationNotice = {
    items: [
        { delegationId: 'task-1', sessionId: 'session-1', event: 'completed' },
        { delegationId: 'task-2', sessionId: 'session-2', event: 'question' },
    ],
};
const TEXT =
    '[Caxri] Delegated task update:\n- task-1 completed\n- task-2 is asking you a question';

function userMessage(id: string, text: string, extra = {}): AgentChatPatchOperation {
    return { op: 'upsertItem', item: { id, turnId: 't1', type: 'userMessage', text, ...extra } };
}

describe('stampDelegationNotices', () => {
    const noticeOf = (text: string) => (text === TEXT ? NOTICE : undefined);

    it('marks a user message that matches a delivered notice, with every item', () => {
        const [operation] = stampDelegationNotices([userMessage('u1', TEXT)], noticeOf);

        expect(operation).toMatchObject({ item: { id: 'u1', delegationNotice: NOTICE } });
    });

    it('recognizes the message after the provider leaves leading whitespace', () => {
        const [operation] = stampDelegationNotices([userMessage('u1', `\n  ${TEXT}`)], noticeOf);

        expect(operation).toMatchObject({ item: { delegationNotice: NOTICE } });
    });

    it('leaves a lookalike a person typed as a plain message', () => {
        const typed = [
            userMessage('u1', TEXT.replace('completed', 'failed')),
            userMessage('u2', 'hello'),
        ];

        expect(stampDelegationNotices(typed, noticeOf)).toBe(typed);
    });

    it('does not look up other items or messages that already carry a stamp', () => {
        const lookup = vi.fn(noticeOf);
        const operations: AgentChatPatchOperation[] = [
            {
                op: 'upsertItem',
                item: {
                    id: 'a1',
                    turnId: 't1',
                    type: 'agentMessage',
                    text: TEXT,
                    streaming: false,
                },
            },
            userMessage('u1', TEXT, { delegatedTask: { delegationId: 'task-1' } }),
            userMessage('u2', TEXT, { delegationNotice: NOTICE }),
        ];

        expect(stampDelegationNotices(operations, lookup)).toBe(operations);
        expect(lookup).not.toHaveBeenCalled();
    });
});

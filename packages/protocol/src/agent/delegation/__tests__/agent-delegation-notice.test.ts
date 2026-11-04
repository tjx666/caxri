import { describe, expect, it } from 'vitest';

import {
    agentChatDelegationNoticeSchema,
    delegationNoticeEventSchema,
    delegationNoticeEventTone,
    MAX_DELEGATION_NOTICE_ITEMS,
} from '../agent-delegated-task';

describe('delegationNoticeEventTone', () => {
    it('reds a failure, ambers what waits on the user, and quiets the rest', () => {
        expect(
            Object.fromEntries(
                delegationNoticeEventSchema.options.map((event) => [
                    event,
                    delegationNoticeEventTone(event),
                ]),
            ),
        ).toEqual({
            completed: 'muted',
            failed: 'danger',
            interrupted: 'muted',
            taken_over: 'muted',
            answer_unavailable: 'danger',
            settled: 'muted',
            handed_back: 'muted',
            question: 'warning',
            approval: 'warning',
        });
    });
});

describe('agentChatDelegationNoticeSchema', () => {
    const item = { delegationId: 'task-1', sessionId: 'session-1', event: 'completed' };

    it('holds IDs and a closed event only', () => {
        expect(agentChatDelegationNoticeSchema.safeParse({ items: [item] }).success).toBe(true);
        expect(
            agentChatDelegationNoticeSchema.safeParse({
                items: [{ ...item, title: 'Run: rm -rf' }],
            }).success,
        ).toBe(false);
        expect(
            agentChatDelegationNoticeSchema.safeParse({ items: [{ ...item, event: 'exploded' }] })
                .success,
        ).toBe(false);
    });

    it('lists between one and the most a message carries', () => {
        expect(agentChatDelegationNoticeSchema.safeParse({ items: [] }).success).toBe(false);
        expect(
            agentChatDelegationNoticeSchema.safeParse({
                items: Array.from({ length: MAX_DELEGATION_NOTICE_ITEMS + 1 }, () => item),
            }).success,
        ).toBe(false);
    });
});

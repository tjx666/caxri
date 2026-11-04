import { delegationNoticeEventSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { noticeEventKey } from '../agent-chat-delegation-notice';
import {
    buildAgentChatTimeline,
    isAgentChatTurnStart,
    withAgentChatAwaitingReply,
} from '../agent-chat-timeline';

const notice = {
    items: [
        { delegationId: 'd1', sessionId: 's1', event: 'completed' as const },
        { delegationId: 'd2', sessionId: 's2', event: 'question' as const },
    ],
};

const snapshot = {
    items: [
        {
            id: 'u1',
            turnId: 't1',
            type: 'userMessage' as const,
            text: '[Caxri] Delegated task update:\n- d1 completed',
            delegationNotice: notice,
        },
        { id: 'u2', turnId: 't2', type: 'userMessage' as const, text: 'Plain message' },
    ],
    turns: [
        { id: 't1', status: 'completed' as const },
        { id: 't2', status: 'completed' as const },
    ],
};

describe('buildAgentChatTimeline delegation notices', () => {
    it('draws a delivered notice as compact rows that start a turn, never as a bubble', () => {
        const entries = buildAgentChatTimeline(snapshot);

        expect(entries[0]).toEqual({ kind: 'delegationNotice', id: 'u1', notice });
        expect(isAgentChatTurnStart(entries[0])).toBe(true);
        expect(entries.find((entry) => entry.id === 'u2')).toMatchObject({ kind: 'message' });
    });

    it('waits for the reply the notice woke, as it does after a message', () => {
        const entries = buildAgentChatTimeline({ ...snapshot, items: snapshot.items.slice(0, 1) });

        expect(
            withAgentChatAwaitingReply(entries, {
                activeTurnId: 't1',
                operation: undefined,
                requests: [],
            }).at(-1),
        ).toMatchObject({ kind: 'awaiting' });
    });
});

describe('noticeEventKey', () => {
    it.each(delegationNoticeEventSchema.options)('has a status word for %s', (event) => {
        expect(translate(noticeEventKey(event))).not.toBe(noticeEventKey(event));
    });
});

import { delegationNoticeEventSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../../i18n';
import { noticeEventKey, noticeRowKey } from '../agent-chat-delegation-notice';

describe('noticeEventKey', () => {
    it.each(delegationNoticeEventSchema.options)('has a status word for %s', (event) => {
        expect(translate(noticeEventKey(event))).not.toBe(noticeEventKey(event));
    });

    it('uses the status words the owner named', () => {
        expect(
            (
                [
                    'completed',
                    'failed',
                    'interrupted',
                    'taken_over',
                    'handed_back',
                    'question',
                    'approval',
                ] as const
            ).map((event) => translate(noticeEventKey(event))),
        ).toEqual([
            'completed',
            'failed',
            'interrupted',
            'taken over',
            'handed back',
            'asking a question',
            'needs approval',
        ]);
    });
});

describe('noticeRowKey', () => {
    it('tells two events of one task apart', () => {
        expect(noticeRowKey({ delegationId: 'd1', event: 'question' })).not.toBe(
            noticeRowKey({ delegationId: 'd1', event: 'completed' }),
        );
    });
});

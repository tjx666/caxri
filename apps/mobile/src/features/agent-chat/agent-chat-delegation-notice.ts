import type { DelegationNoticeEvent } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';

/**
 * The status word of each event of a delivered settlement notice, in Desktop's terms.
 */
const NOTICE_EVENT_KEYS = {
    completed: 'chat.delegationNotice.completed',
    failed: 'chat.delegationNotice.failed',
    interrupted: 'chat.delegationNotice.interrupted',
    taken_over: 'chat.delegationNotice.taken_over',
    handed_back: 'chat.delegationNotice.handed_back',
    question: 'chat.delegationNotice.question',
    approval: 'chat.delegationNotice.approval',
    answer_unavailable: 'chat.delegationNotice.answer_unavailable',
    settled: 'chat.delegationNotice.settled',
} as const satisfies Record<DelegationNoticeEvent, TranslationKey>;

export function noticeEventKey(event: DelegationNoticeEvent): TranslationKey {
    return NOTICE_EVENT_KEYS[event];
}

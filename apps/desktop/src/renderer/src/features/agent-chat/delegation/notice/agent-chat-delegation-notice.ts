import type { DelegationNoticeEvent } from '@caxri/protocol';

import type { TranslationKey } from '../../../../i18n';

/**
 * The status word of each event of a delivered settlement notice, in Desktop's terms.
 */
const NOTICE_EVENT_KEYS = {
    completed: 'delegation.notice.completed',
    failed: 'delegation.notice.failed',
    interrupted: 'delegation.notice.interrupted',
    taken_over: 'delegation.notice.taken_over',
    handed_back: 'delegation.notice.handed_back',
    question: 'delegation.notice.question',
    approval: 'delegation.notice.approval',
    answer_unavailable: 'delegation.notice.answer_unavailable',
    settled: 'delegation.notice.settled',
} as const satisfies Record<DelegationNoticeEvent, TranslationKey>;

export function noticeEventKey(event: DelegationNoticeEvent): TranslationKey {
    return NOTICE_EVENT_KEYS[event];
}

/**
 * The React key of a row. Server Core lists each task and event once per notice, so the pair is unique within one.
 */
export function noticeRowKey(item: { delegationId: string; event: DelegationNoticeEvent }): string {
    return `${item.delegationId}:${item.event}`;
}

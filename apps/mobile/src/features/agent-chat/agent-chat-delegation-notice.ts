import type { DelegationNoticeEvent } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';

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

/**
 * The one spoken label of a notice row, "<status>: <title>", so a screen reader announces which Session the update is
 * about instead of reading the icon, title, and status as three loose pieces.
 */
export function delegationNoticeRowLabel(
    t: Translate,
    event: DelegationNoticeEvent,
    title: string,
): string {
    return t('chat.delegationNotice.rowLabel', { status: t(noticeEventKey(event)), title });
}

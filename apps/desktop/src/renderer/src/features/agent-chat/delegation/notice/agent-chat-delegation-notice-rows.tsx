import type { AgentChatDelegationNotice, DelegationNoticeEvent } from '@caxri/protocol';
import { delegationNoticeEventTone } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react';
import {
    CircleAlert,
    CircleCheck,
    CircleQuestionMark,
    CircleSlash,
    CircleX,
    Hand,
    ShieldAlert,
    Undo2,
} from 'lucide-react';

import { useTranslation } from '../../../../i18n';
import { cn } from '../../../../lib/utilities';
import { useSessionById } from '../../../../stores/selectors';
import { openSession } from '../../../session/session-commands';
import { sessionTitleForDisplay } from '../../../session/session-title';
import { noticeEventKey, noticeRowKey } from './agent-chat-delegation-notice';

const ICONS: Record<DelegationNoticeEvent, LucideIcon> = {
    completed: CircleCheck,
    failed: CircleX,
    interrupted: CircleSlash,
    taken_over: Hand,
    handed_back: Undo2,
    question: CircleQuestionMark,
    approval: ShieldAlert,
    answer_unavailable: CircleAlert,
    settled: CircleCheck,
};

const TONE_CLASS_NAMES = {
    danger: 'text-danger',
    muted: 'text-muted',
    warning: 'text-warning',
} as const;

const ROW_CLASS_NAME =
    'flex w-full min-w-0 items-center gap-2 rounded px-1 py-0.5 text-[12px] leading-5 text-muted';

/**
 * One item of a delivered notice: an icon, the child Session's title, and what happened to it. The title is read from
 * the Workbench's own Session data by ID, never from the message text. The row opens the Session; a Session the
 * Workbench no longer lists reads as unavailable and does not open.
 */
function DelegationNoticeRow({ item }: { item: AgentChatDelegationNotice['items'][number] }) {
    const { t } = useTranslation();
    const session = useSessionById(item.sessionId);
    const Icon = ICONS[item.event];
    const status = t(noticeEventKey(item.event));
    const title = session ? sessionTitleForDisplay(session.title, t) : undefined;
    const content = (
        <>
            <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                <Icon
                    aria-hidden="true"
                    className={cn(
                        'size-3.5',
                        TONE_CLASS_NAMES[delegationNoticeEventTone(item.event)],
                    )}
                />
            </span>
            <span className="min-w-0 flex-1 truncate">
                {title ?? t('delegation.notice.unavailable')}
            </span>
            <span className="shrink-0">{status}</span>
        </>
    );
    return title === undefined ? (
        <div className={ROW_CLASS_NAME} data-agent-chat-delegation-notice-item={item.delegationId}>
            {content}
        </div>
    ) : (
        <button
            aria-label={t('delegation.notice.openAria', { status, title })}
            className={cn(
                ROW_CLASS_NAME,
                'cursor-pointer border-0 bg-transparent text-left hover:bg-list-hover-background hover:text-list-hover-foreground focus-visible:outline focus-visible:outline-accent',
            )}
            data-agent-chat-delegation-notice-item={item.delegationId}
            type="button"
            onClick={() => openSession(item.sessionId)}
        >
            {content}
        </button>
    );
}

/**
 * A settlement notice Caxri delivered to this Chat's Agent, in place of the user bubble its raw text would be: one
 * compact line per task, stacked when one message reports several. The text the Agent received is unchanged; this only
 * draws it.
 */
export function AgentChatDelegationNoticeRows({ notice }: { notice: AgentChatDelegationNotice }) {
    return (
        <div className="flex w-full flex-col" data-agent-chat-delegation-notice="">
            {notice.items.map((item) => (
                <DelegationNoticeRow item={item} key={noticeRowKey(item)} />
            ))}
        </div>
    );
}

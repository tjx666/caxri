import { Goal } from 'lucide-react';

import type { TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { AgentChatGoalReply } from './agent-chat-goal-reply';

const ACTION_LABELS = {
    set: 'agentChat.goal.notice.set',
    cleared: 'agentChat.goal.notice.cleared',
    active: 'agentChat.goal.status.active',
    none: 'agentChat.goal.notice.none',
} as const satisfies Record<AgentChatGoalReply['action'], TranslationKey>;

/**
 * A `/goal` reply as a goal event: the goal mark and what happened in the accent the composer's goal chip uses, with
 * the condition below it as the user wrote it. A cleared goal or an empty `/goal` settles into neutral, since nothing
 * is pursued anymore.
 */
export function AgentChatGoalNotice({ notice }: { notice: AgentChatGoalReply }) {
    const { t } = useTranslation();
    const isPursued = notice.action === 'set' || notice.action === 'active';
    return (
        <div
            className={cn(
                'flex gap-3 rounded-lg border px-3 py-2.5',
                notice.objective ? 'items-start' : 'items-center',
                isPursued ? 'border-accent/25 bg-accent/5' : 'border-border bg-surface',
            )}
            data-agent-chat-goal-notice={notice.action}
        >
            <span
                aria-hidden="true"
                className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-md',
                    isPursued ? 'bg-accent/15 text-accent' : 'bg-foreground/5 text-muted',
                )}
            >
                <Goal className="size-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 select-text">
                <span
                    className={cn(
                        'text-[11px] leading-4 font-medium',
                        isPursued ? 'text-accent' : 'text-muted',
                    )}
                >
                    {t(ACTION_LABELS[notice.action])}
                </span>
                {notice.objective && (
                    <p
                        className={cn(
                            'm-0 text-[13px] leading-5 wrap-anywhere whitespace-pre-wrap',
                            isPursued ? 'text-foreground' : 'text-muted',
                        )}
                    >
                        {notice.objective}
                    </p>
                )}
                {notice.detail && (
                    <p className="m-0 text-[12px] leading-5 wrap-anywhere whitespace-pre-wrap text-muted">
                        {notice.detail}
                    </p>
                )}
            </div>
        </div>
    );
}

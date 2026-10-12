import type { AgentChatActivity } from '@caxri/protocol';
import { formatNoticeableDuration } from '@caxri/protocol';
import { Info, MessageCircleQuestionMark } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { useClockTick } from './hooks/use-clock-tick';

function ElapsedTime({ startedAt }: { startedAt: number }) {
    const label = formatNoticeableDuration(useClockTick('second') - startedAt);
    return label ? <span className="shrink-0 tabular-nums">{label}</span> : null;
}

/**
 * The composer strip's row while the Chat starts, works, or waits on the user. The strip sits on top of the card rather
 * than inside it, so the Chat's state never reads as part of what the user is typing. A working turn shows its verb
 * under a sweeping highlight and how long it has run, so a long turn reads as progress rather than a stall. The polite
 * live region stays mounted so transitions between starting, working, and waiting are announced, while the ticking time
 * never is. The Esc hint is also clickable, so pointing at it gives feedback instead of reading as dead text. While a
 * turn runs and the user has typed something, the row also says what Enter and Cmd+Enter will do with it, because the
 * difference between queueing and steering is otherwise invisible until the message lands. A `notice` (why Enter did
 * not send, or that a second Enter sends an unmatched `/` draft as text) takes the live region while it lasts and shows
 * as its own row, so a refused Enter is never silent.
 */
export function AgentChatActivityBar({
    activity,
    notice,
    onStop,
    showsDeliveryHint,
}: {
    activity: AgentChatActivity | undefined;
    /**
     * A short-lived composer message (`useAgentChatComposerNotice`), or a hint that lasts while its draft does.
     */
    notice: string | undefined;
    onStop: () => void;
    /**
     * A turn is running and the draft has content, so Enter queues and Cmd+Enter steers.
     */
    showsDeliveryHint: boolean;
}) {
    const { t } = useTranslation();
    return (
        <>
            <span aria-live="polite" className="sr-only" role="status">
                {notice ?? activity?.text}
            </span>
            {activity && (
                <div
                    aria-hidden="true"
                    className="flex h-8 items-center gap-2 border-0 border-b border-solid border-border px-3 text-[12px] text-muted"
                    data-agent-chat-composer-strip-row=""
                >
                    {activity.kind === 'waiting' ? (
                        <MessageCircleQuestionMark className="size-3.5 shrink-0 text-warning" />
                    ) : (
                        <Spinner className="size-3.5 shrink-0" role="presentation" />
                    )}
                    <span className="min-w-0 truncate">
                        <span
                            className={activity.kind === 'waiting' ? undefined : 'activity-shimmer'}
                        >
                            {activity.text}
                        </span>
                    </span>
                    {activity.kind === 'working' && activity.startedAt !== undefined && (
                        <ElapsedTime startedAt={activity.startedAt} />
                    )}
                    {showsDeliveryHint && (
                        <span className="ml-auto shrink-0 text-[11px] whitespace-nowrap">
                            <kbd className="font-sans">Enter</kbd>{' '}
                            {t('agentChat.activity.enterHint')} ·{' '}
                            <kbd className="font-sans">⌘Enter</kbd>{' '}
                            {t('agentChat.activity.steerHint')}
                        </span>
                    )}
                    {(activity.kind === 'working' ||
                        (activity.kind === 'compacting' && activity.isStoppable)) && (
                        /*
                         * A pointer shortcut for the Esc hint. It stays out of the tab order and the accessibility
                         * tree with the rest of this row: the composer's Stop button is the accessible control.
                         */
                        <button
                            className={cn(
                                '-mr-1.5 shrink-0 cursor-pointer rounded border-0 bg-transparent px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-elevated hover:text-foreground',
                                !showsDeliveryHint && 'ml-auto',
                            )}
                            tabIndex={-1}
                            type="button"
                            onClick={onStop}
                        >
                            <kbd className="font-sans">Esc</kbd> {t('agentChat.activity.stopHint')}
                        </button>
                    )}
                </div>
            )}
            {notice && (
                <div
                    aria-hidden="true"
                    className="flex h-8 items-center gap-2 border-0 border-b border-solid border-border px-3 text-[12px] text-muted"
                    data-agent-chat-composer-strip-row=""
                >
                    <Info className="size-3.5 shrink-0" />
                    <span className="min-w-0 truncate">{notice}</span>
                </div>
            )}
        </>
    );
}

import { formatShortDuration } from '@caxri/protocol';
import { MessageCircleQuestionMark } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/utilities';
import type { AgentChatActivity } from './agent-chat-presentation';
import { useClockTick } from './hooks/use-clock-tick';

function ElapsedTime({ startedAt }: { startedAt: number }) {
    const elapsed = useClockTick('second') - startedAt;
    // Below a second the count would read `<1s` and jump straight to `1s`, which looks like a glitch.
    if (elapsed < 1000) return null;
    return <span className="shrink-0 tabular-nums">{formatShortDuration(elapsed)}</span>;
}

/**
 * The composer's first row while the Chat starts, works, or waits on the user. It sits inside the card, above a
 * hairline, so the composer keeps one rounded outline instead of growing a tab on top. A working turn shows its verb
 * under a sweeping highlight and how long it has run, so a long turn reads as progress rather than a stall. The polite
 * live region stays mounted so transitions between starting, working, and waiting are announced, while the ticking time
 * never is. The Esc hint is also clickable, so pointing at it gives feedback instead of reading as dead text. While a
 * turn runs and the user has typed something, the row also says what Enter and Cmd+Enter will do with it, because the
 * difference between queueing and steering is otherwise invisible until the message lands.
 */
export function AgentChatActivityBar({
    activity,
    onStop,
    showsDeliveryHint,
}: {
    activity: AgentChatActivity | undefined;
    onStop: () => void;
    /**
     * A turn is running and the draft has content, so Enter queues and Cmd+Enter steers.
     */
    showsDeliveryHint: boolean;
}) {
    return (
        <>
            <span aria-live="polite" className="sr-only" role="status">
                {activity?.text}
            </span>
            {activity && (
                <div
                    aria-hidden="true"
                    className="flex h-8 items-center gap-2 border-0 border-b border-solid border-border px-3 text-[12px] text-muted"
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
                            <kbd className="font-sans">Enter</kbd> to queue ·{' '}
                            <kbd className="font-sans">⌘Enter</kbd> to steer
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
                                '-mr-1.5 shrink-0 cursor-pointer rounded border-0 bg-transparent px-1.5 py-0.5 text-[11px] text-muted transition-colors duration-(--motion-overlay-enter) ease-(--motion-ease-enter) hover:bg-elevated hover:text-foreground',
                                !showsDeliveryHint && 'ml-auto',
                            )}
                            tabIndex={-1}
                            type="button"
                            onClick={onStop}
                        >
                            <kbd className="font-sans">Esc</kbd> to stop
                        </button>
                    )}
                </div>
            )}
        </>
    );
}

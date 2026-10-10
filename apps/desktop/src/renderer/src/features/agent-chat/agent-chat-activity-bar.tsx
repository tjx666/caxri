import { useSyncExternalStore } from 'react';

import { formatShortDuration } from '@caxri/protocol';
import { MessageCircleQuestionMark } from 'lucide-react';

import { Spinner } from '../../components/ui/spinner';
import type { AgentChatActivity } from './agent-chat-presentation';

const TICK_MS = 1000;

function subscribeToSecondTick(onTick: () => void): () => void {
    const timer = setInterval(onTick, TICK_MS);
    return () => clearInterval(timer);
}

/**
 * `now` quantized to whole seconds, so the snapshot is stable between ticks and only this line re-renders each second.
 * The clock runs only while a turn is working, because nothing else mounts it.
 */
function getSecondSnapshot(): number {
    return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

function ElapsedTime({ startedAt }: { startedAt: number }) {
    const now = useSyncExternalStore(subscribeToSecondTick, getSecondSnapshot);
    const elapsed = now - startedAt;
    // Below a second the count would read `<1s` and jump straight to `1s`, which looks like a glitch.
    if (elapsed < TICK_MS) return null;
    return <span className="shrink-0 tabular-nums">{formatShortDuration(elapsed)}</span>;
}

/**
 * The status tab on top of the composer while the Chat starts, works, or waits on the user. A working turn shows its
 * verb under a sweeping highlight and how long it has run, so a long turn reads as progress rather than a stall. The
 * polite live region stays mounted so transitions between starting, working, and waiting are announced, while the
 * ticking time never is.
 */
export function AgentChatActivityBar({ activity }: { activity: AgentChatActivity | undefined }) {
    return (
        <>
            <span aria-live="polite" className="sr-only" role="status">
                {activity?.text}
            </span>
            {activity && (
                <div
                    aria-hidden="true"
                    className="mx-3 flex h-7 items-center gap-2 rounded-t-md border border-b-0 border-border bg-surface px-3 text-[12px] text-muted"
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
                    {activity.kind === 'working' && (
                        <span className="ml-auto shrink-0 text-[11px]">
                            <kbd className="font-sans">Esc</kbd> to stop
                        </span>
                    )}
                </div>
            )}
        </>
    );
}

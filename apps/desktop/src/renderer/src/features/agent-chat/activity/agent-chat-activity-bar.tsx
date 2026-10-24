import type { AgentChatActivity, AgentChatSnapshot } from '@caxri/protocol';
import { Info } from 'lucide-react';
import { domMax, LazyMotion, MotionConfig } from 'motion/react';

import { useHasLasted } from '../../../hooks/use-has-lasted';
import { useShouldReduceMotion } from '../../../hooks/use-should-reduce-motion';
import { useTranslation } from '../../../i18n';
import { useIsAgentChatStopping } from '../hooks/use-agent-chat-stop';
import { useAgentChatSeenFailures } from './status-row/agent-chat-seen-failures';
import { AgentChatStatusRow } from './status-row/agent-chat-status-row';
import {
    agentChatLatestTurnStart,
    agentChatStatusRowAnnouncement,
    agentChatStatusRowView,
} from './status-row/agent-chat-status-row-view';

/**
 * How long a Chat loads its conversation or starts its Agent before the status row says so. Opening a Chat usually
 * finishes both within a few hundred milliseconds, and a row that unfolds and folds again in that time only pushes the
 * transcript up and back down.
 */
const STARTING_ROW_DELAY_MS = 1000;

/**
 * The composer strip's status rows: the one status row (`AgentChatStatusRow`) whenever the Chat is busy or something it
 * started still needs the user, and a `notice` row (why Enter did not send, or that a second Enter sends an unmatched
 * `/` draft as text) while one lasts, so a refused Enter is never silent. The strip sits on top of the card rather than
 * inside it, so the Chat's state never reads as part of what the user is typing. The status row unfolds when it has
 * something to say and folds away once nothing is left, instead of popping. The polite live region stays mounted so
 * transitions are announced, while the ticking time and figures never are. The row appears and leaves at once: an
 * unfolding and folding row pushed the transcript up and back down whenever a turn started or ended, and with several
 * rows trading places the strip read as jumping. Motion inside the row (the verb swap) honors the system's
 * reduced-motion preference: positions and sizes snap while fades remain.
 */
export function AgentChatActivityBar({
    activity,
    notice,
    snapshot,
    terminalId,
    turnId,
    onOpenTask,
    onPopoverClosed,
}: {
    activity: AgentChatActivity | undefined;
    /**
     * A short-lived composer message (`useAgentChatComposerNotice`), or a hint that lasts while its draft does.
     */
    notice: string | undefined;
    snapshot: Pick<AgentChatSnapshot, 'plan' | 'tasks' | 'turns'> | undefined;
    /**
     * The Chat Terminal, whose pending Stop turns the row into `Stopping…`.
     */
    terminalId: string;
    /**
     * The running turn, which seeds Buddy's rare party hat so it stays on for the whole turn.
     */
    turnId: string | undefined;
    /**
     * Opens a background task's tab beside the Chat; absent where the host cannot (see `canOpenBesideChat`).
     */
    onOpenTask: ((taskId: string) => void) | undefined;
    /**
     * The element that takes focus when the row's popover closes by pointer or with its row.
     */
    onPopoverClosed: () => HTMLElement | null;
}) {
    const { t } = useTranslation();
    const isStopping = useIsAgentChatStopping(terminalId, turnId) && activity?.kind === 'working';
    const isReducedMotion = useShouldReduceMotion();
    const hasStartingLasted = useHasLasted(
        activity?.kind === 'starting' ? terminalId : undefined,
        STARTING_ROW_DELAY_MS,
    );
    const view = agentChatStatusRowView({
        activity: !hasStartingLasted && activity?.kind === 'starting' ? undefined : activity,
        latestTurnStartedAt: agentChatLatestTurnStart(snapshot),
        plan: snapshot?.plan,
        seenFailureIds: useAgentChatSeenFailures(terminalId),
        tasks: snapshot?.tasks,
    });
    const activityText = isStopping ? t('agentChat.activity.stopping') : (activity?.text ?? '');
    return (
        <LazyMotion strict features={domMax}>
            <MotionConfig reducedMotion={isReducedMotion ? 'always' : 'never'}>
                <span aria-live="polite" className="sr-only" role="status">
                    {notice ?? (view && agentChatStatusRowAnnouncement(view, activityText, t))}
                </span>
                {view && (
                    <div
                        className="border-0 border-b border-solid border-border"
                        data-agent-chat-composer-strip-row=""
                    >
                        <AgentChatStatusRow
                            isStopping={isStopping}
                            isTurnRunning={turnId !== undefined}
                            terminalId={terminalId}
                            turnId={turnId}
                            usage={activity?.kind === 'working' ? activity.usage : undefined}
                            view={view}
                            onOpenTask={onOpenTask}
                            onPopoverClosed={onPopoverClosed}
                        />
                    </div>
                )}
            </MotionConfig>
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
        </LazyMotion>
    );
}

import type { AgentChatActivity } from '@caxri/protocol';
import { Info } from 'lucide-react';
import { domMax, LazyMotion, MotionConfig } from 'motion/react';

import { useHasLasted } from '../../../hooks/use-has-lasted';
import { useShouldReduceMotion } from '../../../hooks/use-should-reduce-motion';
import { useTranslation } from '../../../i18n';
import { useIsAgentChatStopping } from '../hooks/use-agent-chat-stop';
import { AgentChatStatusRow } from './status-row/agent-chat-status-row';

/**
 * How long a Chat loads its conversation or starts its Agent before the status row says so. Opening a Chat usually
 * finishes both within a few hundred milliseconds, and a row that unfolds and folds again in that time only pushes the
 * transcript up and back down.
 */
const STARTING_ROW_DELAY_MS = 1000;

/**
 * The composer strip's status rows: the status row (`AgentChatStatusRow`) while the Chat starts, works, or compacts,
 * and a `notice` row (why Enter did not send, or that a second Enter sends an unmatched `/` draft as text) while one
 * lasts, so a refused Enter is never silent. The strip sits on top of the card rather than inside it, so the Chat's
 * state never reads as part of what the user is typing. A turn waiting on the user shows no row: its request card right
 * above already says so. The polite live region stays mounted so transitions between starting, working, and waiting are
 * announced, while the ticking time and figures never are. The row appears and leaves at once: an unfolding and folding
 * row pushed the transcript up and back down whenever a turn started or ended. Motion inside the row (the verb swap)
 * honors the system's reduced-motion preference: positions and sizes snap while fades remain.
 */
export function AgentChatActivityBar({
    activity,
    isInGoalRow,
    notice,
    terminalId,
    turnId,
}: {
    activity: AgentChatActivity | undefined;
    /**
     * Whether the goal row shows the turn's work (`agentChatLiveGoalActivity`), so this row stays out of the strip
     * while its live region still announces the work.
     */
    isInGoalRow: boolean;
    /**
     * A short-lived composer message (`useAgentChatComposerNotice`), or a hint that lasts while its draft does.
     */
    notice: string | undefined;
    /**
     * The Chat Terminal, whose pending Stop turns the row into `Stopping…`.
     */
    terminalId: string;
    /**
     * The running turn, which seeds Buddy's rare party hat so it stays on for the whole turn.
     */
    turnId: string | undefined;
}) {
    const { t } = useTranslation();
    const isStopping = useIsAgentChatStopping(terminalId, turnId) && activity?.kind === 'working';
    const isReducedMotion = useShouldReduceMotion();
    const hasStartingLasted = useHasLasted(
        activity?.kind === 'starting' ? terminalId : undefined,
        STARTING_ROW_DELAY_MS,
    );
    const rowActivity =
        activity?.kind === 'waiting' || (!hasStartingLasted && activity?.kind === 'starting')
            ? undefined
            : activity;
    const activityText = isStopping ? t('agentChat.activity.stopping') : activity?.text;
    return (
        <LazyMotion strict features={domMax}>
            <MotionConfig reducedMotion={isReducedMotion ? 'always' : 'never'}>
                <span aria-live="polite" className="sr-only" role="status">
                    {notice ?? activityText}
                </span>
                {rowActivity && !isInGoalRow && (
                    <div
                        className="border-0 border-b border-solid border-border"
                        data-agent-chat-composer-strip-row=""
                    >
                        <AgentChatStatusRow
                            activity={rowActivity}
                            isStopping={isStopping}
                            turnId={turnId}
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

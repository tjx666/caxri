import type { ReactNode } from 'react';

import type { AgentChatActivity, AgentChatQueuedMessage, AgentChatSnapshot } from '@caxri/protocol';

import { SurfaceErrorBoundary } from '../../../components/surface-error-boundary';
import { useTranslation } from '../../../i18n';
import { AgentChatGoalBar } from '../activity/agent-chat-goal-bar';
import type { AgentChatWorkingActivity } from '../activity/agent-chat-goal-row';
import { AgentChatDelegatedSessionsSection } from '../delegation/agent-chat-delegated-sessions-section';
import { useCanShowDelegatedSessions } from '../delegation/hooks/use-can-show-delegated-sessions';
import { AgentChatDelegationOriginRow } from '../delegation/origin/agent-chat-delegation-origin-row';
import type { AgentChatPendingMessage } from '../transcript/agent-chat-pending';
import { AgentChatQueueList } from './agent-chat-queue-list';
import { AgentChatBackgroundWorkSection } from './strip/agent-chat-background-work-section';
import { AgentChatPlanSection } from './strip/agent-chat-plan-section';
import { useAgentChatSeenFailures } from './strip/agent-chat-seen-failures';
import {
    agentChatBackgroundWork,
    agentChatBackgroundWorkCounts,
    agentChatLatestTurnStart,
    agentChatPlanSection,
} from './strip/agent-chat-strip-sections';

/**
 * Guards one strip section. A section that throws while rendering shows an inline fault row in its slot while the
 * transcript, the composer input, and the other sections keep working; without it the throw reached the whole-Chat
 * boundary and replaced transcript and composer with its fault view. The boundary renders no wrapper element, so the
 * strip's `data-agent-chat-composer-strip-row` collapse rule is unaffected.
 */
function AgentChatStripSection({
    children,
    name,
    terminalId,
}: {
    children: ReactNode;
    name: string;
    terminalId: string;
}) {
    return (
        <SurfaceErrorBoundary layout="inline" resetKey={`${terminalId}:${name}`} scope="chat-strip">
            {children}
        </SurfaceErrorBoundary>
    );
}

/**
 * The strip on the composer card's top edge, inset from its corners like a tab, so the Chat's state reads as separate
 * from the draft. Everything that waits above the input stacks in it as hairline-divided rows rather than separate
 * cards, as LobeHub's input trays and T3 Code's composer drawer do: the goal, the Agent's plan, the Sessions it
 * delegated work to (above its background work, since a delegated Session is the larger unit of work the user follows),
 * its background work as collapsible lists (so they are visible without opening anything, the way Claude Code's TUI
 * lists them above its prompt), queued messages, then the composer's own rows (`children`: the status row nearest the
 * input, since it changes most often, the edit bar, and the context notices). Its last row's hairline overlaps the
 * card's top border; with no row it collapses to `contents`, keeping the live regions announced without drawing an
 * empty tab.
 */
export function AgentChatComposerStrip({
    activeTurnId,
    activity,
    children,
    goalActivity,
    isQueuePaused,
    isShown,
    isTurnRunning,
    pendingQueue,
    queue,
    snapshot,
    terminalId,
    onOpenTask,
    onQueueAction,
    onQueueEdit,
}: {
    activeTurnId: string | undefined;
    activity: AgentChatActivity | undefined;
    children: ReactNode;
    /**
     * The running turn's work when the goal row shows it (`agentChatLiveGoalActivity`).
     */
    goalActivity: AgentChatWorkingActivity | undefined;
    isQueuePaused: boolean;
    /**
     * Whether this Chat is on screen. The Delegated Sessions section reads a live feed, so a kept-alive Chat in the
     * background mounts none and the progress events cost only the Chat being looked at.
     */
    isShown: boolean;
    isTurnRunning: boolean;
    pendingQueue: readonly AgentChatPendingMessage[];
    queue: readonly AgentChatQueuedMessage[] | undefined;
    snapshot:
        | Pick<
              AgentChatSnapshot,
              'goal' | 'goalUsage' | 'plan' | 'queuePauseReason' | 'tasks' | 'turns'
          >
        | undefined;
    terminalId: string;
    /**
     * Opens a background task's tab beside the Chat; absent where the host cannot (see `canOpenBesideChat`).
     */
    onOpenTask: ((taskId: string) => void) | undefined;
    onQueueAction: () => void;
    onQueueEdit: (text: string) => void;
}) {
    const { t } = useTranslation();
    const canShowDelegated = useCanShowDelegatedSessions();
    const plan = agentChatPlanSection({ activity, plan: snapshot?.plan });
    const work = agentChatBackgroundWork({
        latestTurnStartedAt: agentChatLatestTurnStart(snapshot),
        seenFailureIds: useAgentChatSeenFailures(terminalId),
        tasks: snapshot?.tasks,
    });
    return (
        <div
            // The strip and its rows appear and leave at once, without a fade or an unfolding height: they report state,
            // and animating them made the composer's top edge jump whenever a row came or went (DESIGN.md "Motion").
            className="mx-3 -mb-px overflow-hidden rounded-t-lg border border-b-0 border-solid border-border bg-surface not-has-[[data-agent-chat-composer-strip-row]]:contents"
            data-agent-chat-composer-strip=""
        >
            {/*
             * The sections above the composer's own rows share one height cap and scroll past it, so a long plan, task
             * list, and queue in a short split pane never squeeze the transcript away.
             */}
            <span aria-live="polite" className="sr-only" role="status">
                {work && agentChatBackgroundWorkCounts(work, t).join(', ')}
            </span>
            <div className="max-h-64 overflow-y-auto">
                <AgentChatStripSection name="delegation-origin" terminalId={terminalId}>
                    <AgentChatDelegationOriginRow
                        isBusy={
                            isTurnRunning || pendingQueue.length > 0 || (queue?.length ?? 0) > 0
                        }
                        terminalId={terminalId}
                    />
                </AgentChatStripSection>
                <AgentChatStripSection name="goal" terminalId={terminalId}>
                    <AgentChatGoalBar
                        goal={snapshot?.goal}
                        goalUsage={snapshot?.goalUsage}
                        liveActivity={goalActivity}
                        terminalId={terminalId}
                        turnId={activeTurnId}
                        turns={snapshot?.turns}
                    />
                </AgentChatStripSection>
                {plan && (
                    <AgentChatStripSection name="plan" terminalId={terminalId}>
                        <AgentChatPlanSection
                            isTurnRunning={isTurnRunning}
                            section={plan}
                            terminalId={terminalId}
                        />
                    </AgentChatStripSection>
                )}
                {isShown && canShowDelegated && (
                    <AgentChatStripSection name="delegated" terminalId={terminalId}>
                        <AgentChatDelegatedSessionsSection terminalId={terminalId} />
                    </AgentChatStripSection>
                )}
                {work && (
                    <AgentChatStripSection name="background-work" terminalId={terminalId}>
                        <AgentChatBackgroundWorkSection
                            terminalId={terminalId}
                            work={work}
                            onOpenTask={onOpenTask}
                        />
                    </AgentChatStripSection>
                )}
                <AgentChatStripSection name="queue" terminalId={terminalId}>
                    <AgentChatQueueList
                        isTurnRunning={isTurnRunning}
                        pending={pendingQueue}
                        queue={queue}
                        snapshot={{
                            queuePaused: isQueuePaused,
                            queuePauseReason: snapshot?.queuePauseReason,
                        }}
                        terminalId={terminalId}
                        onAction={onQueueAction}
                        onEdit={onQueueEdit}
                    />
                </AgentChatStripSection>
            </div>
            {children}
        </div>
    );
}

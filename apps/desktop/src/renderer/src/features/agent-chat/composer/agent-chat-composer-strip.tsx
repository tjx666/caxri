import type { ReactNode } from 'react';

import type { AgentChatActivity, AgentChatQueuedMessage, AgentChatSnapshot } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { AgentChatGoalBar } from '../activity/agent-chat-goal-bar';
import type { AgentChatWorkingActivity } from '../activity/agent-chat-goal-row';
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
 * The strip on the composer card's top edge, inset from its corners like a tab, so the Chat's state reads as separate
 * from the draft. Everything that waits above the input stacks in it as hairline-divided rows rather than separate
 * cards, as LobeHub's input trays and T3 Code's composer drawer do: the goal, the Agent's plan and its background work
 * as collapsible lists (so both are visible without opening anything, the way Claude Code's TUI lists them above its
 * prompt), queued messages, then the composer's own rows (`children`: the status row nearest the input, since it
 * changes most often, the edit bar, and the context notices). Its last row's hairline overlaps the card's top border;
 * with no row it collapses to `contents`, keeping the live regions announced without drawing an empty tab.
 */
export function AgentChatComposerStrip({
    activeTurnId,
    activity,
    children,
    goalActivity,
    isQueuePaused,
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
                <AgentChatGoalBar
                    goal={snapshot?.goal}
                    goalUsage={snapshot?.goalUsage}
                    liveActivity={goalActivity}
                    terminalId={terminalId}
                    turnId={activeTurnId}
                    turns={snapshot?.turns}
                />
                {plan && (
                    <AgentChatPlanSection
                        isTurnRunning={isTurnRunning}
                        section={plan}
                        terminalId={terminalId}
                    />
                )}
                {work && (
                    <AgentChatBackgroundWorkSection
                        terminalId={terminalId}
                        work={work}
                        onOpenTask={onOpenTask}
                    />
                )}
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
            </div>
            {children}
        </div>
    );
}

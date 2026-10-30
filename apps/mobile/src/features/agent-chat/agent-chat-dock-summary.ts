import type { AgentChatSnapshot } from '@caxri/protocol';
import { agentChatActivity } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { agentChatGoalBarView } from './agent-chat-goal';
import { agentChatTaskPill } from './agent-chat-tasks';

/**
 * Which docked rows (goal, activity, queue, background work) the Chat has right now, as one line of text each.
 */
export interface AgentChatDockSummary {
    /**
     * The non-empty segments in dock order, ready to join into the folded row's single line.
     */
    segments: string[];
    /**
     * Whether the dock stacks several rows, which is when folding them into one row is worth a tap.
     */
    isStacked: boolean;
}

/**
 * The folded form of the goal bar, status row, and queue card. Built from the snapshot alone, so it reads the same
 * facts the three rows read: the goal's status (`Pursuing goal`), what the turn is doing, the queue count, and the
 * running background work. A saved copy has none of them, as each row hides on one.
 */
export const agentChatDockSummary = (
    snapshot: AgentChatSnapshot | undefined,
    {
        isSavedCopy,
        provider,
        queueCount,
    }: {
        isSavedCopy: boolean;
        provider: string;
        /**
         * Messages waiting, including those this phone is still sending into the queue.
         */
        queueCount: number;
    },
    t: Translate = translate,
): AgentChatDockSummary => {
    if (!snapshot || isSavedCopy) return { segments: [], isStacked: false };
    const segments: string[] = [];
    const goal = agentChatGoalBarView(snapshot, 0, false, t);
    if (goal) segments.push(goal.status);
    const activity = agentChatActivity(snapshot, provider, {}, t);
    if (activity && activity.kind !== 'starting') segments.push(activity.text);
    if (queueCount > 0) segments.push(`${t('chat.queue.queued')} ${queueCount}`);
    const running = agentChatTaskPill(snapshot, t)?.running ?? [];
    if (running.length > 0) segments.push(t('chat.tasks.runningCount', { count: running.length }));
    return { segments, isStacked: segments.length >= 2 };
};

/**
 * Whether the dock folds into its one summary row: only with the keyboard up, where the composer and keyboard already
 * take most of the screen, and only until the user expands it.
 */
export const isAgentChatDockFolded = ({
    isExpanded,
    isKeyboardShown,
    isStacked,
}: {
    isExpanded: boolean;
    isKeyboardShown: boolean;
    isStacked: boolean;
}): boolean => isKeyboardShown && isStacked && !isExpanded;

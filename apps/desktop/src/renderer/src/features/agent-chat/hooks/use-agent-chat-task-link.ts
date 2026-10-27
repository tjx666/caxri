import { createContext, useContext, useMemo } from 'react';

import type { AgentChatItem, AgentChatTask } from '@caxri/protocol';
import { agentChatTasksByItem } from '@caxri/protocol';

import { openAgentChatTaskTab, openAgentChatTurnReview } from '../tasks/agent-chat-task-opener';
import type { AgentChatTaskLink } from '../tasks/agent-chat-tasks';
import { agentChatTaskLinkForItem } from '../tasks/agent-chat-tasks';

/**
 * What a Chat's timeline knows about its tasks: the tasks keyed by the item that started each and, where the host can
 * open a tab beside the Chat, how to open one and how to open a turn's review. Provided by every Chat pane; a task
 * tab's own read-only timeline provides nothing, so its rows stay plain.
 *
 * `tasksByItem` is always present because it drives live task status, not just navigation: a row whose subagent or
 * background shell still runs stays out of the `Ran N commands` summary and shows its elapsed time (issue caxri#1719).
 * The openers are absent in the Caxri Bot window, which mounts no pane layout to open a tab in, so its rows offer no
 * Open button and its turns no review while keeping their live status.
 */
export interface AgentChatTaskLinks {
    tasksByItem: ReadonlyMap<string, AgentChatTask>;
    openTask?: (taskId: string) => void;
    openTurnReview?: (turnId: string) => void;
}

export const AgentChatTaskLinksContext = createContext<AgentChatTaskLinks | undefined>(undefined);

/**
 * Builds the Chat pane's task links: always the task index, plus the beside-Chat openers only when `canOpenBesideChat`
 * (see `agentChatHostCapabilities`).
 */
export function createAgentChatTaskLinks(
    tasks: readonly AgentChatTask[] | undefined,
    terminalId: string,
    canOpenBesideChat: boolean,
): AgentChatTaskLinks {
    const tasksByItem = agentChatTasksByItem(tasks);
    if (!canOpenBesideChat) return { tasksByItem };
    return {
        tasksByItem,
        openTask: (taskId) => openAgentChatTaskTab(terminalId, taskId),
        openTurnReview: (turnId) => openAgentChatTurnReview(terminalId, turnId),
    };
}

/**
 * What the Chat pane provides (see {@link createAgentChatTaskLinks}). Memoized on the task list so a streamed delta that
 * leaves tasks alone does not re-render every memoized work row.
 */
export function useAgentChatTaskLinks(
    tasks: readonly AgentChatTask[] | undefined,
    terminalId: string,
    canOpenBesideChat: boolean,
): AgentChatTaskLinks {
    return useMemo(
        () => createAgentChatTaskLinks(tasks, terminalId, canOpenBesideChat),
        [canOpenBesideChat, tasks, terminalId],
    );
}

/**
 * Opens one turn's review beside the Chat, or `undefined` where the Chat cannot open a tab.
 */
export function useAgentChatTurnReviewOpener(): ((turnId: string) => void) | undefined {
    return useContext(AgentChatTaskLinksContext)?.openTurnReview;
}

/**
 * The task a timeline row belongs to, or `undefined` for an ordinary row. `open` is absent where the Chat cannot open a
 * tab beside itself; the row still shows the task's live status.
 */
export function useAgentChatTaskLink(
    item: AgentChatItem,
): (AgentChatTaskLink & { open?: () => void }) | undefined {
    const links = useContext(AgentChatTaskLinksContext);
    if (!links) return undefined;
    const link = agentChatTaskLinkForItem(item, links.tasksByItem);
    if (!link) return undefined;
    const { openTask } = links;
    return openTask ? { ...link, open: () => openTask(link.taskId) } : link;
}

import { createContext, useContext, useMemo } from 'react';

import type { AgentChatItem, AgentChatTask } from '@caxri/protocol';

import { openAgentChatTaskTab, openAgentChatTurnReview } from '../agent-chat-task-opener';
import type { AgentChatTaskLink } from '../agent-chat-tasks';
import { agentChatTaskLinkForItem, agentChatTasksByItem } from '../agent-chat-tasks';

/**
 * What a Chat's timeline needs to open a tab beside the Chat: the tasks keyed by the item that started each, how to
 * open one, and how to open a turn's review. Provided by a Workbench Chat pane; a task tab's own read-only timeline and
 * the Agent Commander window's Chat (which mounts no pane layout to open a tab in) provide nothing, so their rows stay
 * plain and their turns offer no review.
 */
export interface AgentChatTaskLinks {
    tasksByItem: ReadonlyMap<string, AgentChatTask>;
    openTask: (taskId: string) => void;
    openTurnReview: (turnId: string) => void;
}

export const AgentChatTaskLinksContext = createContext<AgentChatTaskLinks | undefined>(undefined);

/**
 * What the Chat pane provides: rows that started a subagent or background shell open its tab beside this Chat, or
 * nothing when the host cannot open a tab there (`canOpenBesideChat` in `agentChatHostCapabilities`). Memoized on the
 * task list so a streamed delta that leaves tasks alone does not re-render every memoized work row.
 */
export function useAgentChatTaskLinks(
    tasks: readonly AgentChatTask[] | undefined,
    terminalId: string,
    canOpenBesideChat: boolean,
): AgentChatTaskLinks | undefined {
    return useMemo(
        () =>
            canOpenBesideChat
                ? {
                      tasksByItem: agentChatTasksByItem(tasks),
                      openTask: (taskId) => openAgentChatTaskTab(terminalId, taskId),
                      openTurnReview: (turnId) => openAgentChatTurnReview(terminalId, turnId),
                  }
                : undefined,
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
 * The task a timeline row opens, with the opener, or `undefined` for an ordinary row.
 */
export function useAgentChatTaskLink(
    item: AgentChatItem,
): (AgentChatTaskLink & { open: () => void }) | undefined {
    const links = useContext(AgentChatTaskLinksContext);
    if (!links) return undefined;
    const link = agentChatTaskLinkForItem(item, links.tasksByItem);
    return link && { ...link, open: () => links.openTask(link.taskId) };
}

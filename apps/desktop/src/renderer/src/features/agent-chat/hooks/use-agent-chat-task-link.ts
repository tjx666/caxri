import { createContext, useContext, useMemo } from 'react';

import type { AgentChatItem, AgentChatTask } from '@caxri/protocol';

import { openAgentChatTaskTab } from '../agent-chat-task-opener';
import type { AgentChatTaskLink } from '../agent-chat-tasks';
import { agentChatTaskLinkForItem, agentChatTasksByItem } from '../agent-chat-tasks';

/**
 * What a Chat's timeline needs to turn a row into a door to its task: the tasks keyed by the item that started each,
 * and how to open one. Provided by the Chat pane; a task tab's own read-only timeline provides nothing, so its rows
 * stay plain.
 */
export interface AgentChatTaskLinks {
    tasksByItem: ReadonlyMap<string, AgentChatTask>;
    openTask: (taskId: string) => void;
}

export const AgentChatTaskLinksContext = createContext<AgentChatTaskLinks | undefined>(undefined);

/**
 * What the Chat pane provides: rows that started a subagent or background shell open its tab beside this Chat. Memoized
 * on the task list so a streamed delta that leaves tasks alone does not re-render every memoized work row.
 */
export function useAgentChatTaskLinks(
    tasks: readonly AgentChatTask[] | undefined,
    terminalId: string,
): AgentChatTaskLinks {
    return useMemo(
        () => ({
            tasksByItem: agentChatTasksByItem(tasks),
            openTask: (taskId) => openAgentChatTaskTab(terminalId, taskId),
        }),
        [tasks, terminalId],
    );
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

import { createContext, useContext } from 'react';

import type { AgentChatItem, AgentChatTask } from '@caxri/protocol';

import type { AgentChatTaskLink } from '../agent-chat-tasks';
import { agentChatTaskLinkForItem } from '../agent-chat-tasks';

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

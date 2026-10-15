import type { AgentChatTask } from '@caxri/protocol';
import { findAgentChatTask, isCaxriError, parseAgentTaskTab } from '@caxri/protocol';

import { useCaxriQuery } from '../../../queries/client';

/**
 * One task's live projection for its tab: the task's own conversation or output (`agentChat.readTask`, kept current by
 * `agentChat.taskPatch` in `agent-chat-client.ts`), and its metadata from the Chat's task list. Reading the Chat here
 * too is deliberate: a restored task tab is often the only view of its Chat on screen, and it needs the status, title,
 * and Stop affordance only that list carries.
 *
 * `isUnavailable` is true when Server Core answered `NOT_FOUND`: neither the live Chat nor the provider's history knows
 * the task, which a retry will not change.
 */
export function useAgentChatTask(terminalId: string, taskId: string) {
    const chat = useCaxriQuery('agentChat.read', { terminalId }, { staleTime: Infinity });
    const task = findAgentChatTask(chat.data?.tasks, taskId);
    const requestedId = task?.id ?? taskId;
    /**
     * A tab opened from a timeline row may carry the row's item id, while `agentChat.taskPatch` events name the task's
     * own id. Reading under the task's id is what lets those patches reach this cache; the item id read only bridges
     * the moment before the Chat lists the task.
     */
    const lookup = useCaxriQuery(
        'agentChat.readTask',
        { terminalId, taskId: requestedId },
        { staleTime: Infinity },
    );
    const canonicalId = lookup.data?.taskId ?? requestedId;
    const canonical = useCaxriQuery(
        'agentChat.readTask',
        { terminalId, taskId: canonicalId },
        {
            staleTime: Infinity,
            enabled: canonicalId !== requestedId,
            initialData: lookup.data,
        },
    );
    const projection = canonicalId === requestedId ? lookup : canonical;
    const isUnavailable = isCaxriError(projection.error) && projection.error.code === 'NOT_FOUND';
    return { projection, task, isUnavailable };
}

/**
 * The task a tab path names, for its label and icon; undefined for any other path. Reads only what the Chat already
 * cached (never starts a read), so the tab strip cannot wake a provider; the tab's own surface performs the read.
 */
export function useCachedAgentChatTask(
    tabPath: string,
): Pick<AgentChatTask, 'kind' | 'title'> | undefined {
    const tab = parseAgentTaskTab(tabPath);
    const query = useCaxriQuery(
        'agentChat.read',
        { terminalId: tab?.terminalId ?? '' },
        {
            enabled: false,
            select: (snapshot) => {
                const task = tab ? findAgentChatTask(snapshot.tasks, tab.taskId) : undefined;
                return task && { kind: task.kind, title: task.title };
            },
        },
    );
    return tab ? query.data : undefined;
}

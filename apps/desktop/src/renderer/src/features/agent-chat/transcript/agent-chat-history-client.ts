import type {
    AgentChatItem,
    AgentChatOlderHistory,
    AgentChatSnapshot,
    AgentChatTaskSnapshot,
} from '@caxri/protocol';
import {
    agentChatHistoryCursor,
    emptyAgentChatOlderHistory,
    hasOlderAgentChatHistory,
    prependAgentChatHistoryPage,
    retainEvictedAgentChatItems,
} from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import { caxri } from '../../../lib/caxri';
import { caxriQueryKey, isQueryMethod, queryClient } from '../../../queries/client';

/**
 * Whose history is paged: a Chat's own, or (with `taskId`, the task's own id) one subagent task's, which the task tab
 * pages the same way.
 */
export interface AgentChatHistoryScope {
    terminalId: string;
    taskId?: string;
}

/**
 * The part of a projection that history paging reads. A task has no `historyId` of its own: its page identity is the
 * task id, and its items carry no turns.
 */
export interface AgentChatHistoryWindow {
    historyId?: string | undefined;
    items: AgentChatItem[];
    truncated: boolean;
}

/**
 * Where the history a Chat pane read back is cached: beside the projection, one entry per `historyId`, so a replaced
 * conversation starts empty and a remounted pane keeps what it already read.
 */
export function agentChatHistoryQueryKey(
    terminalId: string,
    historyId: string | undefined,
    taskId?: string,
): readonly unknown[] {
    return taskId === undefined
        ? ['agentChat.history', terminalId, historyId ?? null]
        : ['agentChat.history', terminalId, historyId ?? null, taskId];
}

/**
 * A task's window with the turns a task never has, the same object as `previous` while its items did not change.
 */
function taskWindow(
    snapshot: AgentChatTaskSnapshot,
    previous: (AgentChatHistoryWindow & { turns: AgentChatSnapshot['turns'] }) | undefined,
): AgentChatHistoryWindow & { turns: AgentChatSnapshot['turns'] } {
    if (previous?.historyId === snapshot.taskId && previous.items === snapshot.items)
        return previous;
    return {
        historyId: snapshot.taskId,
        items: snapshot.items,
        truncated: snapshot.truncated,
        turns: [],
    };
}

function windowOfTask(
    snapshot: AgentChatTaskSnapshot | undefined,
): AgentChatHistoryWindow | undefined {
    return (
        snapshot && {
            historyId: snapshot.taskId,
            items: snapshot.items,
            truncated: snapshot.truncated,
        }
    );
}

/**
 * The projection the scope pages in front of, as cached.
 */
function cachedWindow(scope: AgentChatHistoryScope): AgentChatHistoryWindow | undefined {
    return scope.taskId === undefined
        ? queryClient.getQueryData<AgentChatSnapshot>(
              caxriQueryKey('agentChat.read', { terminalId: scope.terminalId }),
          )
        : windowOfTask(
              queryClient.getQueryData<AgentChatTaskSnapshot>(
                  caxriQueryKey('agentChat.readTask', scope as Required<AgentChatHistoryScope>),
              ),
          );
}

/**
 * The cached history for the projection's current `historyId`, or an empty one.
 */
export function cachedAgentChatHistory(
    client: QueryClient,
    terminalId: string,
    historyId: string | undefined,
    taskId?: string,
): AgentChatOlderHistory {
    return (
        client.getQueryData<AgentChatOlderHistory>(
            agentChatHistoryQueryKey(terminalId, historyId, taskId),
        ) ?? emptyAgentChatOlderHistory(historyId)
    );
}

const loading = new Set<string>();

function loadingKey({ terminalId, taskId }: AgentChatHistoryScope): string {
    return `${terminalId}\0${taskId ?? ''}`;
}

/**
 * Reads the page before the oldest item the pane holds and puts it in front. `onBeforePrepend` runs while the DOM still
 * shows the old transcript, so the view can hold the entry the reader looks at in place. A call while the Chat's page
 * is on its way does nothing.
 */
export async function loadOlderAgentChatHistory(
    scope: AgentChatHistoryScope,
    onBeforePrepend: () => void,
): Promise<void> {
    const { terminalId, taskId } = scope;
    const snapshot = cachedWindow(scope);
    const { historyId } = snapshot ?? {};
    const queryKey = agentChatHistoryQueryKey(terminalId, historyId, taskId);
    const history = cachedAgentChatHistory(queryClient, terminalId, historyId, taskId);
    const cursor = agentChatHistoryCursor(history, snapshot);
    const key = loadingKey(scope);
    if (!cursor || loading.has(key) || !hasOlderAgentChatHistory(history, snapshot)) return;
    loading.add(key);
    const update = (change: (current: AgentChatOlderHistory) => AgentChatOlderHistory): void => {
        queryClient.setQueryData<AgentChatOlderHistory>(queryKey, (current) =>
            change(current ?? emptyAgentChatOlderHistory(historyId)),
        );
    };
    update((current) => ({ ...current, status: 'loading' }));
    try {
        const page = await caxri.request('agentChat.readHistory', {
            terminalId,
            beforeItemId: cursor,
            ...(taskId !== undefined && { taskId }),
        });
        const live = cachedWindow(scope)?.items ?? [];
        const current =
            queryClient.getQueryData<AgentChatOlderHistory>(queryKey) ??
            emptyAgentChatOlderHistory(historyId);
        const next = prependAgentChatHistoryPage(current, page, live);
        // Only a page that adds entries moves the transcript; holding the view for one that does not would leave the
        // hold to pull the view back on an unrelated later change.
        if (next.items !== current.items) onBeforePrepend();
        queryClient.setQueryData<AgentChatOlderHistory>(queryKey, { ...next, status: 'idle' });
    } catch {
        update((current) => ({ ...current, status: 'failed' }));
    } finally {
        loading.delete(key);
    }
}

/**
 * Moves the items each Chat or task projection evicts into the history its pane read back, whichever way the projection
 * changed (a patch or a full re-read). Without it, a conversation that keeps streaming while the user reads back would
 * open a gap between the pages read and the projection.
 */
export function subscribeAgentChatHistoryRetention(client: QueryClient): () => void {
    const seen = new Map<string, AgentChatHistoryWindow & { turns: AgentChatSnapshot['turns'] }>();
    return client.getQueryCache().subscribe((event) => {
        const queryKey = event.query.queryKey as readonly unknown[];
        const isTask = isQueryMethod(queryKey, 'agentChat.readTask');
        if (!isTask && !isQueryMethod(queryKey, 'agentChat.read')) return;
        const { terminalId, taskId } = queryKey[1] as { terminalId: string; taskId?: string };
        const seenKey = loadingKey({ terminalId, taskId: isTask ? taskId : undefined });
        if (event.type === 'removed') {
            seen.delete(seenKey);
            return;
        }
        if (event.type !== 'updated') return;
        const data = event.query.state.data as
            AgentChatSnapshot | AgentChatTaskSnapshot | undefined;
        if (!data) return;
        const previous = seen.get(seenKey);
        const next = isTask
            ? taskWindow(data as AgentChatTaskSnapshot, previous)
            : (data as AgentChatSnapshot);
        if (next === previous) return;
        seen.set(seenKey, next);
        if (!previous || previous.historyId !== next.historyId) return;
        const historyKey = agentChatHistoryQueryKey(
            terminalId,
            next.historyId,
            isTask ? next.historyId : undefined,
        );
        const history = client.getQueryData<AgentChatOlderHistory>(historyKey);
        if (!history) return;
        const retained = retainEvictedAgentChatItems(history, previous, next);
        if (retained !== history) client.setQueryData(historyKey, retained);
    });
}

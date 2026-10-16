import { useCallback, useEffect, useState } from 'react';

import type { AgentChatTask } from '@caxri/protocol';
import { isAgentChatTaskActive } from '@caxri/protocol';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useTranslation } from '../../i18n';
import { useMobileClient } from '../connection/mobile-client-provider';
import { AGENT_CHAT_TASK_POLL_MS, agentChatTaskStopError } from './agent-chat-tasks';

const TICK_MS = 1_000;

/**
 * The phone's clock, ticking every second only while `isActive`, so a running task's elapsed time counts up and an
 * ended task's list never re-renders on a timer.
 */
export const useAgentChatTaskClock = (isActive: boolean): number => {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (!isActive) return;
        const timer = setInterval(() => setNow(Date.now()), TICK_MS);
        return () => clearInterval(timer);
    }, [isActive]);
    return now;
};

/**
 * One background task's output tail or subagent messages, read while its detail is open and the app is in the
 * foreground. A running task is re-read every {@link AGENT_CHAT_TASK_POLL_MS}; the task's status is part of the key, so
 * the read after it ends picks up the final output, and nothing polls after that.
 */
export const useAgentChatTaskDetail = (
    terminalId: string,
    task: Pick<AgentChatTask, 'id' | 'status'>,
) => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const isObservable = connectionScopeKey !== null && isForeground && status === 'connected';
    const isRunning = isAgentChatTaskActive(task.status);
    const query = useQuery({
        enabled: isObservable,
        gcTime: 30_000,
        networkMode: 'always',
        placeholderData: keepPreviousData,
        queryFn: () => request('mobile.agentChat.readTask', { terminalId, taskId: task.id }),
        queryKey: ['mobile', 'agentChatTask', connectionScopeKey, terminalId, task.id, task.status],
        refetchInterval: isObservable && isRunning ? AGENT_CHAT_TASK_POLL_MS : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    return {
        detail: query.data,
        isLoading: query.isPending && query.fetchStatus !== 'idle',
        isError: query.isError && query.data === undefined,
    };
};

/**
 * Stop for a Chat's background tasks. A task shows `Stopping…` from the tap until the Chat reports it no longer
 * running; the request returning only means the provider was asked, as with the composer's Stop.
 */
export const useAgentChatTaskStop = (terminalId: string) => {
    const { request } = useMobileClient();
    const { t } = useTranslation();
    const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set());
    const [error, setError] = useState<{ taskId: string; message: string } | null>(null);
    const stop = useCallback(
        async (taskId: string): Promise<void> => {
            setError(null);
            setStoppingIds((current) => new Set([...current, taskId]));
            try {
                await request('mobile.agentChat.stopTask', { terminalId, taskId });
            } catch {
                setStoppingIds(
                    (current) => new Set([...current].filter((stopping) => stopping !== taskId)),
                );
                setError({ taskId, message: agentChatTaskStopError(t) });
            }
        },
        [request, t, terminalId],
    );
    const isStopping = useCallback(
        (task: Pick<AgentChatTask, 'id' | 'status'>): boolean =>
            isAgentChatTaskActive(task.status) && stoppingIds.has(task.id),
        [stoppingIds],
    );
    const errorFor = useCallback(
        (taskId: string): string | undefined =>
            error?.taskId === taskId ? error.message : undefined,
        [error],
    );
    return { errorFor, isStopping, stop };
};

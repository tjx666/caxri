import { useCallback, useEffect, useState } from 'react';

import type { AgentChatWorkflow, AgentUsageReadout } from '@caxri/protocol';
import { useQueries } from '@tanstack/react-query';

import { caxri } from '../../../../lib/caxri';
import {
    isDocumentVisible,
    registerPoll,
    resolvePollIntervalMs,
    subscribeVisibility,
    unregisterPoll,
} from '../../../../lib/poll-scheduler';
import { caxriQueryKey } from '../../../../queries/client';

const RUNNING_MEMBER_POLL_MS = 3_000;

/**
 * An ended member's transcript can still gain its last response, so it is re-read rarely rather than never.
 */
const ENDED_MEMBER_POLL_MS = 30_000;

/**
 * What each started member of a workflow billed (`terminal.agentTaskUsage` under the member's task id), keyed by that
 * id. Running members are re-read every few seconds while the window is visible, ended ones rarely; the reads share
 * their cache with any other reader of the same member.
 */
export function useAgentChatWorkflowUsage(
    terminalId: string,
    workflow: AgentChatWorkflow | undefined,
): ReadonlyMap<string, AgentUsageReadout | null> {
    const [isVisible, setIsVisible] = useState(isDocumentVisible);
    useEffect(() => subscribeVisibility(setIsVisible), []);
    const members = (workflow?.members ?? []).filter(
        (member) => member.taskId !== undefined && member.status !== 'queued',
    );
    const hasRunning = members.some((member) => member.status === 'running');
    const intervalMs = resolvePollIntervalMs(
        hasRunning ? RUNNING_MEMBER_POLL_MS : ENDED_MEMBER_POLL_MS,
    );
    useEffect(() => {
        if (members.length === 0) return;
        const id = registerPoll('terminal.agentTaskUsage:workflow', intervalMs);
        return () => unregisterPoll(id);
    }, [members.length, intervalMs]);
    const ids = members.map((member) => member.taskId ?? '').join(',');
    // `combine` keeps the map's identity until a member's readout changes, so rows re-render only on new usage.
    const combine = useCallback(
        (results: Array<{ data: AgentUsageReadout | null | undefined }>) => {
            const usage = new Map<string, AgentUsageReadout | null>();
            const taskIds = ids.split(',');
            results.forEach((result, index) => {
                const taskId = taskIds[index];
                if (taskId && result.data !== undefined) usage.set(taskId, result.data);
            });
            return usage;
        },
        [ids],
    );
    return useQueries({
        queries: members.map((member) => {
            const parameters = { terminalId, taskId: member.taskId ?? '' };
            return {
                queryKey: caxriQueryKey('terminal.agentTaskUsage', parameters),
                queryFn: () => caxri.request('terminal.agentTaskUsage', parameters),
                staleTime: 1_000,
                retry: false,
                refetchInterval: isVisible
                    ? resolvePollIntervalMs(
                          member.status === 'running'
                              ? RUNNING_MEMBER_POLL_MS
                              : ENDED_MEMBER_POLL_MS,
                      )
                    : (false as const),
            };
        }),
        combine,
    });
}

import { useCallback, useSyncExternalStore } from 'react';

import type { AgentChatTask } from '@caxri/protocol';

import { notifyListeners } from '../../lib/notify-listeners';

/**
 * A background task a timeline row started, with what its detail needs to read and stop it.
 */
export interface AgentChatTaskLinkTarget {
    terminalId: string;
    task: AgentChatTask;
    /**
     * Whether this device may stop the task right now: control access and a live connection.
     */
    canControl: boolean;
}

/**
 * The tasks the on-screen Chat lists, keyed by the timeline item that started each. A command row's detail sheet is
 * rendered deep inside the Conversation list, which knows neither the Chat nor the device's role, so the Background
 * work strip publishes its tasks here and the detail looks its row up, the way Desktop's timeline finds a row's task
 * through `agentChatTasksByItem`.
 */
const links = new Map<string, AgentChatTaskLinkTarget>();
const listeners = new Set<() => void>();

const notify = (): void => {
    notifyListeners(listeners, undefined);
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
};

/**
 * Replaces the links one Chat publishes. An unchanged task keeps its entry, so a detail open on it does not re-render
 * for another task's progress.
 */
export function publishAgentChatTaskLinks(
    terminalId: string,
    tasks: readonly AgentChatTask[],
    canControl: boolean,
): void {
    const published = new Set<string>();
    let isChanged = false;
    for (const task of tasks) {
        if (!task.itemId) continue;
        published.add(task.itemId);
        const current = links.get(task.itemId);
        if (
            current?.terminalId === terminalId &&
            current.task === task &&
            current.canControl === canControl
        )
            continue;
        links.set(task.itemId, { terminalId, task, canControl });
        isChanged = true;
    }
    for (const [itemId, target] of links)
        if (target.terminalId === terminalId && !published.has(itemId)) {
            links.delete(itemId);
            isChanged = true;
        }
    if (isChanged) notify();
}

/**
 * Withdraws every link one Chat published, when it leaves the screen.
 */
export function withdrawAgentChatTaskLinks(terminalId: string): void {
    publishAgentChatTaskLinks(terminalId, [], false);
}

export function agentChatTaskLink(itemId: string): AgentChatTaskLinkTarget | undefined {
    return links.get(itemId);
}

/**
 * The background task the timeline item `itemId` started, while its Chat is on screen and lists it.
 */
export function useAgentChatTaskLink(itemId: string): AgentChatTaskLinkTarget | undefined {
    const read = useCallback(() => links.get(itemId), [itemId]);
    return useSyncExternalStore(subscribe, read, read);
}

/**
 * The subagent the timeline item `itemId` started. A background shell keeps its own row facts (`Background`, `Exit N`),
 * so only a subagent's row and detail title follow the task's status.
 */
export function useAgentChatSubagentTask(itemId: string): AgentChatTask | undefined {
    const task = useAgentChatTaskLink(itemId)?.task;
    return task?.kind === 'agent' ? task : undefined;
}

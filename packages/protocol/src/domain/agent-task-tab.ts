/**
 * Virtual editor tab for one piece of an Agent Chat's background work: a subagent's own conversation or a background
 * shell's output. Like the transcript tab, the encoded string is a plain tab path, so it persists and restores without
 * special casing; the Renderer reads the task through `agentChat.readTask` each time the tab mounts.
 *
 * Identity is the Chat Terminal plus the task key. The key is normally the task's `id`, and may be the timeline item
 * that started a subagent when the live task list no longer knows it (after a restart), which `agentChat.readTask` also
 * accepts. The title is resolved at render time from the Chat's task list, never stored in the path.
 */
export interface AgentTaskTab {
    terminalId: string;
    taskId: string;
}

const AGENT_TASK_TAB_PREFIX = 'caxri-agent-task://';

export function agentTaskTabPath(terminalId: string, taskId: string): string {
    return `${AGENT_TASK_TAB_PREFIX}${encodeURIComponent(terminalId)}/${encodeURIComponent(taskId)}`;
}

export function parseAgentTaskTab(path: string): AgentTaskTab | undefined {
    if (!path.startsWith(AGENT_TASK_TAB_PREFIX)) return undefined;
    const segments = path.slice(AGENT_TASK_TAB_PREFIX.length).split('/');
    if (segments.length !== 2) return undefined;
    const [encodedTerminalId, encodedTaskId] = segments;
    if (!encodedTerminalId || !encodedTaskId) return undefined;
    try {
        return {
            terminalId: decodeURIComponent(encodedTerminalId),
            taskId: decodeURIComponent(encodedTaskId),
        };
    } catch {
        return undefined;
    }
}

export function isAgentTaskTabPath(path: string): boolean {
    return Boolean(parseAgentTaskTab(path));
}

/**
 * The tab's label: the task's title when the Chat still lists it, otherwise what kind of work it is.
 */
export function agentTaskTabLabel(
    task: { kind: 'agent' | 'shell'; title: string } | undefined,
): string {
    const title = task?.title.trim();
    if (title) return title;
    return task?.kind === 'shell' ? 'Shell' : 'Subagent';
}

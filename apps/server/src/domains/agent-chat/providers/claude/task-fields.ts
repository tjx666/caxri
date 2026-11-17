import type { AgentChatItem, AgentChatTask } from '@caxri/protocol';

import { clip, isRecord } from '../../chat-items';

/**
 * Maps the fields of Claude Code's `system/task_*` frames, and of the timeline rows that started them, onto a listed
 * task. Inputs are untrusted JSON.
 */

/**
 * A task status Claude Code reports, as the Chat lists it; `undefined` for a status Caxri does not know.
 */
export function claudeTaskStatus(status: unknown): AgentChatTask['status'] | undefined {
    switch (status) {
        case 'pending':
        case 'running':
        case 'paused': {
            return 'running';
        }
        case 'completed':
        case 'failed': {
            return status;
        }
        case 'killed':
        case 'stopped': {
            return 'stopped';
        }
        default: {
            return undefined;
        }
    }
}

/**
 * The token, tool-use, and duration counts of a task's `usage`, keeping only well-formed counts.
 */
export function claudeTaskUsage(usage: unknown): AgentChatTask['usage'] | undefined {
    if (!isRecord(usage)) return undefined;
    const count = (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0
            ? Math.trunc(value)
            : undefined;
    const totalTokens = count(usage.total_tokens);
    const toolUses = count(usage.tool_uses);
    const durationMs = count(usage.duration_ms);
    return {
        ...(totalTokens !== undefined && { totalTokens }),
        ...(toolUses !== undefined && { toolUses }),
        ...(durationMs !== undefined && { durationMs }),
    };
}

/**
 * The parent timeline row of the tool call that started a background shell, when that row is there.
 */
export function claudeShellRow(
    items: readonly AgentChatItem[],
    toolUseId: string | undefined,
): AgentChatItem | undefined {
    const id = toolUseId && clip(toolUseId, 200);
    return id ? items.find((candidate) => candidate.id === id) : undefined;
}

/**
 * The command line and description of the tool call that started a background shell: a Bash row, or a `Monitor` row, a
 * generic tool row whose summary is the command it watches.
 */
export function claudeShellCall(
    items: readonly AgentChatItem[],
    toolUseId: string | undefined,
): { command?: string; description?: string } | undefined {
    const item = claudeShellRow(items, toolUseId);
    if (item?.type === 'command') return { command: item.command, description: item.description };
    return item?.type === 'toolCall' && item.name === 'Monitor'
        ? { command: item.summary }
        : undefined;
}

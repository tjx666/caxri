import type { AgentChatTask } from '@caxri/protocol';

import { isRecord } from './chat-items';

/**
 * Maps the status fields of Claude Code's `system/task_*` frames onto a listed task. Inputs are untrusted JSON.
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

import type { AgentChatItem } from '@caxri/protocol';

import type { AgentChatSessionHost } from './chat-provider';
import { claudeFeedbackItems, claudeFeedbackToolUseId } from './claude-feedback';

type Json = Record<string, unknown>;
type FeedbackItem = Extract<AgentChatItem, { type: 'notice' }>;

/**
 * Keeps tool-scoped Claude feedback with the subagent conversation that emitted the tool. Raw Hook lifecycle frames
 * expose no tool or Agent id and deliberately remain session feedback instead of being guessed into a task.
 */
export class ClaudeTaskFeedback {
    private readonly owners = new Map<string, string>();

    constructor(private readonly host: AgentChatSessionHost) {}

    private apply(taskId: string, items: FeedbackItem[]): void {
        this.host.applyTask(
            taskId,
            items.map((item) => ({ op: 'upsertItem', item })),
        );
    }

    note(taskId: string, items: readonly AgentChatItem[]): void {
        for (const item of items)
            if (['command', 'fileChange', 'toolCall'].includes(item.type))
                this.owners.set(item.id, taskId);
    }

    onMessage(message: Json): boolean {
        const toolUseId = claudeFeedbackToolUseId(message);
        const taskId = toolUseId && this.owners.get(toolUseId);
        if (!taskId) return false;
        const items = claudeFeedbackItems(message, undefined, 'agent');
        if (items.length > 0) this.apply(taskId, items);
        return items.length > 0;
    }

    onTaskMessage(taskId: string, message: Json): boolean {
        const items = claudeFeedbackItems(message, undefined, 'agent');
        if (items.length > 0) this.apply(taskId, items);
        return items.length > 0;
    }

    clear(): void {
        this.owners.clear();
    }
}

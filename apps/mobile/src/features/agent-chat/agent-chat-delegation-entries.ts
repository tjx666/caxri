import type { AgentChatItem } from '@caxri/protocol';

import type { AgentChatTimelineEntry } from './agent-chat-timeline';

/**
 * The row of a user message that Server Core recognized as something other than the user's words: a settlement notice
 * Caxri delivered to this Chat's Agent (compact rows, as Desktop draws them), or another Agent's delegated task pointer
 * (a captioned bubble with the pointer folded away). `undefined` for every other item.
 */
export function delegationEntry(item: AgentChatItem): AgentChatTimelineEntry | undefined {
    if (item.type !== 'userMessage') return undefined;
    if (item.delegationNotice)
        return { kind: 'delegationNotice', id: item.id, notice: item.delegationNotice };
    const task = item.delegatedTask;
    if (!task) return undefined;
    return {
        kind: 'delegated',
        id: item.id,
        body: task.prompt ? { kind: 'prompt', prompt: task.prompt } : { kind: 'pointer' },
        isExpanded: false,
        text: item.text,
        task,
    };
}

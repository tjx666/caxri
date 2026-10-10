import type { AgentChatItem } from '@caxri/protocol';
import { MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import { clip, isRecord, stringField } from './chat-items';
import { ClaudeBlockIds } from './claude-items';

/**
 * The item operations a streamed Claude Code message produces. Both the parent projection and a task projection accept
 * them, so the main conversation and every subagent share one streaming implementation.
 */
export type ClaudeItemOperation =
    { op: 'upsertItem'; item: AgentChatItem } | { op: 'appendText'; itemId: string; delta: string };

/**
 * Streaming state for one conversation: the main thread, or one subagent keyed by its parent tool call. Each keeps its
 * own block ids, so a subagent streaming between the parent's blocks never shifts the parent's item ids.
 */
export class ClaudeStream {
    /**
     * Streamed block index to item id for the model message being streamed, and which of those items exist yet.
     */
    private readonly blocks = new Map<number, string>();

    private readonly streamedItems = new Set<string>();

    private messageId: string | undefined;

    readonly ids = new ClaudeBlockIds();

    constructor(
        private readonly emit: (operations: ClaudeItemOperation[]) => void,
        /**
         * The turn new items join. A task projection has no turns, so a subagent stream omits it.
         */
        private readonly turnId?: () => string | undefined,
    ) {}

    /**
     * Streams a delta into a text or thinking block. The item is created by its first delta rather than its block
     * start, so a thinking block whose content is withheld never shows as an empty row.
     */
    private appendDelta(itemId: string, type: 'agentMessage' | 'reasoning', delta: unknown): void {
        if (typeof delta !== 'string' || !delta) return;
        const text = clip(delta, MAX_AGENT_CHAT_TEXT_LENGTH);
        if (this.streamedItems.has(itemId)) {
            this.emit([{ op: 'appendText', itemId, delta: text }]);
            return;
        }
        this.streamedItems.add(itemId);
        const turnId = this.turnId?.();
        this.emit([
            {
                op: 'upsertItem',
                item: { id: itemId, ...(turnId && { turnId }), type, text, streaming: true },
            },
        ]);
    }

    onEvent(event: unknown): void {
        if (!isRecord(event)) return;
        switch (event.type) {
            case 'message_start': {
                const message = isRecord(event.message) ? event.message : undefined;
                this.messageId = stringField(message?.id);
                this.blocks.clear();
                return;
            }
            case 'content_block_start': {
                const block = isRecord(event.content_block) ? event.content_block : undefined;
                const kind =
                    block?.type === 'text'
                        ? 'text'
                        : block?.type === 'thinking'
                          ? 'thinking'
                          : undefined;
                if (!kind || !this.messageId || typeof event.index !== 'number') return;
                this.blocks.set(event.index, this.ids.open(this.messageId, kind));
                return;
            }
            case 'content_block_delta': {
                const delta = isRecord(event.delta) ? event.delta : undefined;
                const itemId =
                    typeof event.index === 'number' ? this.blocks.get(event.index) : undefined;
                if (!delta || !itemId) return;
                if (delta.type === 'text_delta')
                    this.appendDelta(itemId, 'agentMessage', delta.text);
                else if (delta.type === 'thinking_delta')
                    this.appendDelta(itemId, 'reasoning', delta.thinking);
                return;
            }
            default: {
                // Stop and usage events carry nothing the complete assistant frame does not repeat.
            }
        }
    }

    /**
     * Marks items a complete assistant frame delivered, so a later delta for the same id starts a fresh row.
     */
    settle(items: readonly AgentChatItem[]): void {
        for (const item of items) this.streamedItems.delete(item.id);
    }
}

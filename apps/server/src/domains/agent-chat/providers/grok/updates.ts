import type { AgentChatItem, AgentChatPatchOperation, AgentChatTurn } from '@caxri/protocol';
import { MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import {
    clip,
    closeDanglingItem,
    isRecord,
    MAX_TRACKED_TURNS,
    stringField,
} from '../../chat-items';
import { isQueuedPromptUuid } from '../../queued-prompt-uuid';
import type { GrokToolCall } from './items';
import {
    grokCommands,
    grokDisplayText,
    grokEffort,
    grokToolCallId,
    mapGrokPlan,
    mapGrokToolCall,
    mergeGrokToolCall,
} from './items';

type Json = Record<string, unknown>;

/**
 * The text item deltas currently stream into. Its text is mirrored here so the item can be closed (re-sent with
 * `streaming: false`) when a tool call or the other text kind interrupts it, without reading the projection back.
 */
interface StreamingText {
    id: string;
    type: 'agentMessage' | 'reasoning';
    turnId?: string;
    text: string;
}

/**
 * History a `session/load` replays, folded locally and applied as one reset so a long conversation is not streamed into
 * the projection delta by delta.
 */
interface Replay {
    items: Map<string, AgentChatItem>;
    turns: AgentChatTurn[];
}

export interface GrokUpdatesHost {
    apply: (operations: AgentChatPatchOperation[]) => void;
    /**
     * The running turn's id, which live items belong to.
     */
    activeTurnId: () => string | undefined;
    /**
     * Grok Build settled a permission request itself (another client answered it, or the turn moved on).
     */
    onInteractionResolved: (toolCallId: string) => void;
}

export function stopReasonStatus(stopReason: unknown): AgentChatTurn['status'] {
    return stopReason === 'cancelled' ? 'interrupted' : 'completed';
}

/**
 * Folds `operations` into replayed history: upserts replace by id (keeping first-seen order), and deltas append to the
 * item they name.
 */
function foldReplay(
    replay: Replay,
    operations: readonly AgentChatPatchOperation[],
    eventTime: number | undefined,
): void {
    for (const operation of operations) {
        if (operation.op === 'upsertItem') {
            const { item } = operation;
            const createdAt = replay.items.get(item.id)?.createdAt ?? item.createdAt ?? eventTime;
            replay.items.set(item.id, createdAt === undefined ? item : { ...item, createdAt });
        } else if (operation.op === 'appendText') {
            const item = replay.items.get(operation.itemId);
            if (item?.type === 'agentMessage' || item?.type === 'reasoning')
                replay.items.set(item.id, {
                    ...item,
                    text: clip(item.text + operation.delta, MAX_AGENT_CHAT_TEXT_LENGTH),
                });
        }
    }
}

/**
 * Translates one Grok Build session's ACP updates into projection operations: streamed text, merged tool calls, the
 * plan, and slash commands. During a `session/load` it folds the replayed history instead of applying it.
 */
export class GrokUpdates {
    private readonly toolCalls = new Map<string, GrokToolCall & { turnId?: string }>();

    private readonly declined = new Set<string>();

    private streaming: StreamingText | undefined;

    private replay: Replay | undefined;

    private itemCount = 0;

    /**
     * When the frame being handled was originally emitted, from its `_meta.agentTimestampMs`.
     */
    private eventTime: number | undefined;

    constructor(private readonly host: GrokUpdatesHost) {}

    private emit(operations: AgentChatPatchOperation[]): void {
        if (operations.length === 0) return;
        if (this.replay) foldReplay(this.replay, operations, this.eventTime);
        else this.host.apply(operations);
    }

    /**
     * The turn new items belong to: the running turn live, or the turn being replayed.
     */
    private currentTurnId(): string | undefined {
        return this.replay ? this.replay.turns.at(-1)?.id : this.host.activeTurnId();
    }

    private appendStreaming(type: StreamingText['type'], delta: string): void {
        if (!delta) return;
        const turnId = this.currentTurnId();
        const current = this.streaming;
        if (current?.type === type && current.turnId === turnId) {
            current.text = clip(current.text + delta, MAX_AGENT_CHAT_TEXT_LENGTH);
            this.emit([
                {
                    op: 'appendText',
                    itemId: current.id,
                    delta: clip(delta, MAX_AGENT_CHAT_TEXT_LENGTH),
                },
            ]);
            return;
        }
        this.closeStreaming();
        const next: StreamingText = {
            id: this.nextItemId(turnId, type === 'agentMessage' ? 'message' : 'thought'),
            type,
            ...(turnId && { turnId }),
            text: clip(delta, MAX_AGENT_CHAT_TEXT_LENGTH),
        };
        this.streaming = next;
        this.emit([
            {
                op: 'upsertItem',
                item: {
                    id: next.id,
                    ...(turnId && { turnId }),
                    type,
                    text: next.text,
                    streaming: true,
                },
            },
        ]);
    }

    /**
     * A replayed user message opens a history turn; Grok Build replays it as one or more chunks.
     */
    private replayUserMessage(replay: Replay, text: string, displayText: string | undefined): void {
        const last = replay.turns.at(-1);
        if (displayText !== undefined) {
            // An `_x.ai/interject` replays as its own user message inside the turn it joined, wrapped for the model;
            // `_meta.displayText` is what the user typed. Verified on Grok Build 1.0.62 (#1705, #1721).
            if (!last) return;
            this.closeStreaming();
            const id = this.nextItemId(last.id, 'user');
            replay.items.set(id, {
                id,
                turnId: last.id,
                type: 'userMessage',
                text: clip(displayText, MAX_AGENT_CHAT_TEXT_LENGTH),
                delivery: 'steered',
                ...(this.eventTime !== undefined && { createdAt: this.eventTime }),
            });
            return;
        }
        const lastItem = replay.items.values().toArray().at(-1);
        if (last && lastItem?.type === 'userMessage' && lastItem.id === `${last.id}:user`) {
            replay.items.set(lastItem.id, {
                ...lastItem,
                text: clip(lastItem.text + text, MAX_AGENT_CHAT_TEXT_LENGTH),
            });
            return;
        }
        this.closeStreaming();
        const turnId = `history:${replay.turns.length + 1}`;
        // Closed as interrupted unless its `turn_completed` follows, so a turn cut off by a crash does not read as done.
        replay.turns.push({ id: turnId, status: 'interrupted' });
        replay.items.set(`${turnId}:user`, {
            id: `${turnId}:user`,
            turnId,
            type: 'userMessage',
            text: clip(text, MAX_AGENT_CHAT_TEXT_LENGTH),
            ...(this.eventTime !== undefined && { createdAt: this.eventTime }),
        });
    }

    /**
     * Records when the next frame was originally emitted. Grok Build stamps every frame with `_meta.agentTimestampMs`,
     * and a replayed frame keeps its original time, so a replayed item is dated by the frame that first created it
     * (#1657). Live items are stamped by the projection instead.
     */
    setEventTime(time: unknown): void {
        this.eventTime =
            typeof time === 'number' && Number.isFinite(time) && time >= 0 ? time : undefined;
    }

    nextItemId(turnId: string | undefined, kind: string): string {
        this.itemCount += 1;
        return clip(`${turnId ?? 'session'}:${kind}${this.itemCount}`, 200);
    }

    /**
     * Ends the streaming text item, so the next delta or a later item does not continue it.
     */
    closeStreaming(): void {
        const current = this.streaming;
        if (!current) return;
        this.streaming = undefined;
        this.emit([
            {
                op: 'upsertItem',
                item: {
                    id: current.id,
                    ...(current.turnId && { turnId: current.turnId }),
                    type: current.type,
                    text: current.text,
                    streaming: false,
                },
            },
        ]);
    }

    /**
     * Forgets the streaming item without closing it; the caller closes every dangling item itself.
     */
    dropStreaming(): void {
        this.streaming = undefined;
    }

    /**
     * Merges a `tool_call`, `tool_call_update`, or a permission request's `toolCall` and re-renders its item. Returns
     * `undefined` for an update without a call id.
     */
    upsertToolCall(update: Json): GrokToolCall | undefined {
        const previous = this.toolCalls.get(grokToolCallId(update) ?? '');
        const merged = mergeGrokToolCall(previous, update);
        if (!merged) return undefined;
        const turnId = previous?.turnId ?? this.currentTurnId();
        this.toolCalls.set(merged.id, { ...merged, ...(turnId && { turnId }) });
        this.closeStreaming();
        this.emit([
            {
                op: 'upsertItem',
                item: mapGrokToolCall(merged, turnId, this.declined.has(merged.id)),
            },
        ]);
        return merged;
    }

    /**
     * Marks a tool call the user declined, now and in its later updates.
     */
    decline(toolCallId: string): void {
        this.declined.add(toolCallId);
        const call = this.toolCalls.get(toolCallId);
        if (call) this.emit([{ op: 'upsertItem', item: mapGrokToolCall(call, call.turnId, true) }]);
    }

    onSessionUpdate(update: Json): void {
        const content = isRecord(update.content) ? update.content : undefined;
        const text =
            content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
        switch (update.sessionUpdate) {
            case 'agent_message_chunk': {
                this.appendStreaming('agentMessage', text);
                return;
            }
            case 'agent_thought_chunk': {
                this.appendStreaming('reasoning', text);
                return;
            }
            case 'user_message_chunk': {
                // Live user messages are Caxri's own echo; only a replayed one carries history.
                if (text && this.replay)
                    this.replayUserMessage(this.replay, text, grokDisplayText(content));
                return;
            }
            case 'tool_call':
            case 'tool_call_update': {
                this.upsertToolCall(update);
                return;
            }
            case 'plan': {
                if (this.replay) return; // A replayed plan is stale; only the running turn shows one.
                this.emit([
                    { op: 'state', state: { plan: mapGrokPlan(update, this.currentTurnId()) } },
                ]);
                return;
            }
            case 'available_commands_update': {
                if (!this.replay)
                    this.emit([
                        {
                            op: 'state',
                            state: { commands: grokCommands(update.availableCommands) },
                        },
                    ]);
                return;
            }
            case 'config_option_update': {
                const effort = grokEffort(update.configOptions);
                if (effort && !this.replay) this.emit([{ op: 'state', state: { effort } }]);
                return;
            }
            default: {
                // Mode and session info updates are not conversation content.
            }
        }
    }

    /**
     * Grok Build's own updates (`_x.ai/session_notification` live, `_x.ai/session/update` when replayed).
     */
    onExtensionUpdate(update: Json): void {
        switch (update.sessionUpdate) {
            case 'turn_completed': {
                const turn = this.replay?.turns.at(-1);
                if (!turn) return;
                this.closeStreaming();
                turn.status = stopReasonStatus(update.stop_reason);
                // The replayed `prompt_id` is the `promptId` the prompt was sent with, which carries a queued mark.
                const promptId = stringField(update.prompt_id);
                const message = this.replay?.items.get(`${turn.id}:user`);
                if (promptId && isQueuedPromptUuid(promptId) && message?.type === 'userMessage')
                    this.replay?.items.set(message.id, { ...message, delivery: 'queued' });
                if (typeof update.elapsed_ms === 'number' && update.elapsed_ms >= 0)
                    turn.durationMs = update.elapsed_ms;
                return;
            }
            case 'interaction_resolved': {
                const key = stringField(update.toolCallId);
                if (key) this.host.onInteractionResolved(key);
                return;
            }
            case 'model_changed': {
                const model = stringField(update.model_id);
                if (model && !this.replay)
                    this.emit([{ op: 'state', state: { model: clip(model, 200) } }]);
                return;
            }
            default: {
                // Hook runs, retries, background tasks, and response markers are not conversation content.
            }
        }
    }

    /**
     * Starts folding updates as replayed history instead of applying them.
     */
    beginReplay(): void {
        this.replay = { items: new Map(), turns: [] };
    }

    /**
     * Stops folding. With `isComplete`, returns the operations that replace the projection with the replayed history.
     */
    endReplay(isComplete: boolean): AgentChatPatchOperation[] {
        const replay = this.replay;
        if (isComplete) this.closeStreaming();
        this.replay = undefined;
        this.streaming = undefined;
        if (!isComplete || !replay) return [];
        const operations: AgentChatPatchOperation[] = [{ op: 'reset' }];
        for (const item of replay.items.values())
            operations.push({ op: 'upsertItem', item: closeDanglingItem(item) ?? item });
        operations.push({
            op: 'state',
            state: { turns: replay.turns.slice(-MAX_TRACKED_TURNS), activeTurnId: null },
        });
        return operations;
    }
}

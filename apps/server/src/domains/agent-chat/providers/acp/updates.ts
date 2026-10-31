import type {
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTurn,
} from '@caxri/protocol';
import { MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import { clip, closeDanglingItem, isRecord, MAX_TRACKED_TURNS } from '../../chat-items';
import type { AcpToolCall, AcpToolPresentation } from './items';
import { acpCommands, acpToolCallId, mapAcpPlan, mapAcpToolCall, mergeAcpToolCall } from './items';

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

export interface AcpUpdatesHost {
    apply: (operations: AgentChatPatchOperation[]) => void;
    /**
     * The running turn's id, which live items belong to.
     */
    activeTurnId: () => string | undefined;
    presentation: AcpToolPresentation;
    /**
     * What the user typed, when the provider replays a user message wrapped for the model.
     */
    displayText?: (content: Json | undefined) => string | undefined;
    /**
     * The Chat state a `config_option_update` changes, such as the reasoning effort.
     */
    configState?: (configOptions: unknown) => Partial<AgentChatSnapshot> | undefined;
    /**
     * A live tool call changed, after its update was merged. A `session/load` replay reports none.
     */
    onToolCall?: (call: AcpToolCall) => void;
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
 * Translates one ACP session's updates into projection operations: streamed text, merged tool calls, the plan, and
 * slash commands. During a `session/load` it folds the replayed history instead of applying it.
 */
export class AcpUpdates {
    private readonly toolCalls = new Map<string, AcpToolCall & { turnId?: string }>();

    private readonly declined = new Set<string>();

    private streaming: StreamingText | undefined;

    private replay: Replay | undefined;

    private itemCount = 0;

    /**
     * When the frame being handled was originally emitted, from its `_meta.agentTimestampMs`.
     */
    private eventTime: number | undefined;

    constructor(private readonly host: AcpUpdatesHost) {}

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
     * A replayed user message opens a history turn; agents replay it as one or more chunks.
     */
    private replayUserMessage(replay: Replay, text: string, displayText: string | undefined): void {
        const last = replay.turns.at(-1);
        if (displayText !== undefined) {
            // A message steered into a running turn replays as its own user message inside that turn, wrapped for the
            // model; the display text is what the user typed (Grok Build's `_meta.displayText`).
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
        // Closed as interrupted unless the provider marks it finished, so a turn cut off by a crash does not read as done.
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
     * Records when the next frame was originally emitted, for an agent that stamps its frames (Grok Build's
     * `_meta.agentTimestampMs`). A replayed frame keeps its original time, so a replayed item is dated by the frame
     * that first created it (#1657). Live items are stamped by the projection instead.
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
    upsertToolCall(update: Json): AcpToolCall | undefined {
        const previous = this.toolCalls.get(acpToolCallId(update) ?? '');
        const merged = mergeAcpToolCall(previous, update);
        if (!merged) return undefined;
        const turnId = previous?.turnId ?? this.currentTurnId();
        this.toolCalls.set(merged.id, { ...merged, ...(turnId && { turnId }) });
        this.closeStreaming();
        this.emit([
            {
                op: 'upsertItem',
                item: mapAcpToolCall(
                    merged,
                    turnId,
                    this.declined.has(merged.id),
                    this.host.presentation,
                ),
            },
        ]);
        if (!this.replay) this.host.onToolCall?.(merged);
        return merged;
    }

    /**
     * Marks a tool call the user declined, now and in its later updates.
     */
    decline(toolCallId: string): void {
        this.declined.add(toolCallId);
        const call = this.toolCalls.get(toolCallId);
        if (call)
            this.emit([
                {
                    op: 'upsertItem',
                    item: mapAcpToolCall(call, call.turnId, true, this.host.presentation),
                },
            ]);
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
                    this.replayUserMessage(this.replay, text, this.host.displayText?.(content));
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
                    { op: 'state', state: { plan: mapAcpPlan(update, this.currentTurnId()) } },
                ]);
                return;
            }
            case 'available_commands_update': {
                if (!this.replay)
                    this.emit([
                        {
                            op: 'state',
                            state: { commands: acpCommands(update.availableCommands) },
                        },
                    ]);
                return;
            }
            case 'config_option_update': {
                const state = this.host.configState?.(update.configOptions);
                if (state && !this.replay) this.emit([{ op: 'state', state }]);
                return;
            }
            default: {
                // Mode and session info updates are not conversation content.
            }
        }
    }

    /**
     * Whether a `session/load` replay is being folded.
     */
    get isReplaying(): boolean {
        return this.replay !== undefined;
    }

    /**
     * The replayed turn the latest frames belong to, for a provider extension that reports how it ended.
     */
    replayedTurn(): AgentChatTurn | undefined {
        return this.replay?.turns.at(-1);
    }

    /**
     * A replayed item by id, for a provider extension that annotates it.
     */
    replayedItem(id: string): AgentChatItem | undefined {
        return this.replay?.items.get(id);
    }

    /**
     * Replaces a replayed item, for a provider extension that annotates it.
     */
    setReplayedItem(item: AgentChatItem): void {
        this.replay?.items.set(item.id, item);
    }

    /**
     * Applies a Chat state change outside a replay, for a provider extension that reports one.
     */
    applyState(state: Partial<AgentChatSnapshot>): void {
        if (!this.replay) this.emit([{ op: 'state', state }]);
    }

    /**
     * Starts folding updates as replayed history instead of applying them.
     */
    beginReplay(): void {
        this.replay = { items: new Map(), turns: [] };
    }

    /**
     * Stops folding. With `isComplete`, returns the operations that replace the projection with the replayed history.
     * `settledTurns` is the status every turn the provider did not mark finished gets; an agent that replays no turn
     * ends would otherwise show every past turn as interrupted.
     */
    endReplay(
        isComplete: boolean,
        settledTurns: AgentChatTurn['status'] = 'interrupted',
    ): AgentChatPatchOperation[] {
        const replay = this.replay;
        if (isComplete) this.closeStreaming();
        this.replay = undefined;
        this.streaming = undefined;
        if (!isComplete || !replay) return [];
        for (const turn of replay.turns)
            if (turn.status === 'interrupted') turn.status = settledTurns;
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

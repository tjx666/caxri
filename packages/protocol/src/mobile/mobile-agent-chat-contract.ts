import { z } from 'zod';

import type {
    AgentChatItem,
    AgentChatPatch,
    AgentChatPatchOperation,
    AgentChatSnapshot,
} from '../agent/agent-chat-contract.js';
import { agentChatMethods, agentChatSnapshotSchema } from '../agent/agent-chat-contract.js';
import { identifierSchema } from '../domain/domain.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * A mobile reply or event must fit one sealed gateway frame (64 KiB of plaintext), while a Desktop Chat projection may
 * hold megabytes. The phone therefore reads a window of the newest items and receives patches only when they fit; both
 * stay under this budget with room for the envelope.
 */
export const MOBILE_AGENT_CHAT_MAX_BYTES = 48 * 1_024;

/**
 * Longest text a single mobile item field keeps. Messages and output keep their tail so streamed `appendText` deltas
 * still continue the shortened text; a diff keeps its head, which is where a reader starts.
 */
export const MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH = 4_000;

/**
 * Marks where the phone's copy of an item was shortened. Visible in the transcript so a clipped reply never reads as
 * the whole reply.
 */
export const MOBILE_AGENT_CHAT_CLIP_MARKER = '…';

const MOBILE_AGENT_CHAT_SEND_MAX_BYTES = 16 * 1_024;

const keepTail = (text: string, limit = MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH): string =>
    text.length <= limit ? text : `${MOBILE_AGENT_CHAT_CLIP_MARKER}${text.slice(-limit)}`;

const keepHead = (text: string, limit = MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH): string =>
    text.length <= limit ? text : `${text.slice(0, limit)}\n${MOBILE_AGENT_CHAT_CLIP_MARKER}`;

/**
 * Shortens one item to what a phone can carry. Deterministic, so the snapshot window and later `upsertItem` patches
 * agree on the same item.
 */
export function clipAgentChatItemForMobile(item: AgentChatItem): AgentChatItem {
    switch (item.type) {
        case 'userMessage':
        case 'agentMessage':
        case 'reasoning': {
            return item.text.length <= MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH
                ? item
                : { ...item, text: keepTail(item.text) };
        }
        case 'command': {
            return item.output.length <= MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH
                ? item
                : { ...item, output: keepTail(item.output) };
        }
        case 'toolCall': {
            return !item.output || item.output.length <= MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH
                ? item
                : { ...item, output: keepTail(item.output) };
        }
        case 'fileChange': {
            // One budget for the whole item: later files keep their path and kind but lose their diff.
            let remaining = MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH * 2;
            const changes = item.changes.map((change) => {
                const limit = Math.max(remaining, 0);
                remaining -= change.diff.length;
                if (change.diff.length <= limit) return change;
                return { ...change, diff: limit > 0 ? keepHead(change.diff, limit) : '' };
            });
            return changes.some((change, index) => change !== item.changes[index])
                ? { ...item, changes }
                : item;
        }
        case 'notice': {
            return item;
        }
    }
}

const byteLength = (value: unknown): number =>
    new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * The newest part of a Chat projection that fits one mobile frame. Older items are dropped first and `truncated` is
 * set, the same signal the Desktop projection uses for history it no longer holds.
 */
export function windowAgentChatSnapshotForMobile(snapshot: AgentChatSnapshot): AgentChatSnapshot {
    const items = snapshot.items.map((item) => clipAgentChatItemForMobile(item));
    const activeTurnIds = (kept: readonly AgentChatItem[]) =>
        new Set([
            ...kept.map((item) => item.turnId).filter(Boolean),
            ...(snapshot.activeTurnId ? [snapshot.activeTurnId] : []),
        ]);
    const shell: AgentChatSnapshot = { ...snapshot, items: [], turns: [] };
    let budget = MOBILE_AGENT_CHAT_MAX_BYTES - byteLength(shell);
    let start = items.length;
    while (start > 0) {
        const cost = byteLength(items[start - 1]) + 1;
        if (cost > budget) break;
        budget -= cost;
        start -= 1;
    }
    const kept = items.slice(start);
    const turnIds = activeTurnIds(kept);
    const turns = snapshot.turns.filter((turn) => turnIds.has(turn.id));
    const windowed: AgentChatSnapshot = {
        ...snapshot,
        items: kept,
        turns,
        truncated: snapshot.truncated || start > 0,
    };
    // Turns are small but unbounded by the loop above; drop the oldest items again if they tipped the budget.
    while (windowed.items.length > 0 && byteLength(windowed) > MOBILE_AGENT_CHAT_MAX_BYTES) {
        windowed.items = windowed.items.slice(1);
        windowed.truncated = true;
    }
    return windowed;
}

function clipOperation(operation: AgentChatPatchOperation): AgentChatPatchOperation {
    return operation.op === 'upsertItem'
        ? { op: 'upsertItem', item: clipAgentChatItemForMobile(operation.item) }
        : operation;
}

/**
 * The patch a phone receives, or `undefined` when even the shortened patch would not fit one frame. The gateway then
 * sends a content-free change notice and the phone re-reads its window instead.
 */
export function clipAgentChatPatchForMobile(patch: AgentChatPatch): AgentChatPatch | undefined {
    const clipped: AgentChatPatch = {
        ...patch,
        operations: patch.operations.map((operation) => clipOperation(operation)),
    };
    return byteLength(clipped) <= MOBILE_AGENT_CHAT_MAX_BYTES ? clipped : undefined;
}

const terminalTarget = { terminalId: identifierSchema };

/**
 * Agent Chat from a paired device. Each method resolves the Terminal through the device's granted Projects before it
 * reaches the Chat service; see `docs/agent-chat.md`.
 */
export const mobileAgentChatMethods = {
    /**
     * The newest window of the Chat projection that fits one mobile frame. Starts or resumes the provider like
     * `agentChat.read`.
     */
    'mobile.agentChat.read': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject(terminalTarget),
        result: agentChatSnapshotSchema,
    },
    'mobile.agentChat.send': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.send'].params.refine(
            ({ text }) => new TextEncoder().encode(text).length <= MOBILE_AGENT_CHAT_SEND_MAX_BYTES,
            'Mobile Chat messages must be at most 16 KiB',
        ),
        result: z.null(),
    },
    'mobile.agentChat.interrupt': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject(terminalTarget),
        result: z.null(),
    },
    'mobile.agentChat.respond': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: agentChatMethods['agentChat.respond'].params,
        result: z.null(),
    },
    /**
     * Restarts a failed Chat and resumes its bound conversation, the phone's equivalent of the Desktop pane's Retry.
     * Refused for any Terminal that is not a Chat.
     */
    'mobile.agentChat.retry': {
        ...commandPolicy('server', 'control', ['terminals.steer']),
        params: z.strictObject(terminalTarget),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;

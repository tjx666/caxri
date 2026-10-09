import type {
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatSnapshot,
} from './agent-chat-contract.js';
import {
    MAX_AGENT_CHAT_ITEMS,
    MAX_AGENT_CHAT_OUTPUT_LENGTH,
    MAX_AGENT_CHAT_TEXT_LENGTH,
    MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH,
} from './agent-chat-contract.js';

/**
 * Empty projection for a Chat whose provider has not reported anything yet.
 */
export function emptyAgentChatSnapshot(terminalId: string): AgentChatSnapshot {
    return {
        terminalId,
        revision: 0,
        status: 'stopped',
        truncated: false,
        items: [],
        turns: [],
        requests: [],
    };
}

function itemTextLength(item: AgentChatItem): number {
    switch (item.type) {
        case 'userMessage': {
            return (
                item.text.length +
                (item.images ?? []).reduce(
                    (total, image) => total + (image.thumbnail?.length ?? 0),
                    0,
                )
            );
        }
        case 'agentMessage':
        case 'reasoning': {
            return item.text.length;
        }
        case 'command': {
            return item.command.length + item.output.length;
        }
        case 'fileChange': {
            return item.changes.reduce(
                (total, change) => total + change.path.length + change.diff.length,
                0,
            );
        }
        case 'toolCall': {
            return (item.summary?.length ?? 0) + (item.output?.length ?? 0);
        }
        case 'notice': {
            return item.message?.length ?? 0;
        }
    }
}

/**
 * Keeps the head of a message (later text is dropped once the bound is hit) but the tail of command output, where the
 * end of a long run is what the user needs.
 */
function appendBounded(current: string, delta: string, keep: 'head' | 'tail', limit: number) {
    const next = current + delta;
    if (next.length <= limit) return next;
    return keep === 'head' ? next.slice(0, limit) : next.slice(next.length - limit);
}

function appendToItem(item: AgentChatItem, delta: string): AgentChatItem {
    switch (item.type) {
        case 'agentMessage':
        case 'reasoning':
        case 'userMessage': {
            return {
                ...item,
                text: appendBounded(item.text, delta, 'head', MAX_AGENT_CHAT_TEXT_LENGTH),
            };
        }
        case 'command': {
            return {
                ...item,
                output: appendBounded(item.output, delta, 'tail', MAX_AGENT_CHAT_OUTPUT_LENGTH),
            };
        }
        case 'toolCall': {
            return {
                ...item,
                output: appendBounded(
                    item.output ?? '',
                    delta,
                    'tail',
                    MAX_AGENT_CHAT_OUTPUT_LENGTH,
                ),
            };
        }
        default: {
            return item;
        }
    }
}

/**
 * Drops the oldest items until the projection fits its count and text budgets.
 */
function enforceBudget(snapshot: AgentChatSnapshot): AgentChatSnapshot {
    let { items } = snapshot;
    let isTruncated = snapshot.truncated;
    if (items.length > MAX_AGENT_CHAT_ITEMS) {
        items = items.slice(items.length - MAX_AGENT_CHAT_ITEMS);
        isTruncated = true;
    }
    let total = 0;
    for (const item of items) total += itemTextLength(item);
    let dropCount = 0;
    while (total > MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH && dropCount < items.length - 1) {
        total -= itemTextLength(items[dropCount]);
        dropCount += 1;
    }
    if (dropCount > 0) {
        items = items.slice(dropCount);
        isTruncated = true;
    }
    if (items === snapshot.items) return snapshot;
    const turnIds = new Set(items.map((item) => item.turnId).filter(Boolean));
    const turns = snapshot.turns.filter(
        (turn) => turnIds.has(turn.id) || turn.id === snapshot.activeTurnId,
    );
    return { ...snapshot, items, turns, truncated: isTruncated };
}

/**
 * Applies one patch operation. Shared by Server Core, which owns the projection, and every Client that mirrors it, so
 * both sides converge on the same bounded snapshot.
 */
export function applyAgentChatOperation(
    snapshot: AgentChatSnapshot,
    operation: AgentChatPatchOperation,
): AgentChatSnapshot {
    switch (operation.op) {
        case 'reset': {
            // Commands describe the running provider, not the conversation being replaced.
            return {
                ...emptyAgentChatSnapshot(snapshot.terminalId),
                revision: snapshot.revision,
                ...(snapshot.commands && { commands: snapshot.commands }),
            };
        }
        case 'upsertItem': {
            const index = snapshot.items.findIndex((item) => item.id === operation.item.id);
            const items = [...snapshot.items];
            if (index === -1) items.push(operation.item);
            else items[index] = operation.item;
            return enforceBudget({ ...snapshot, items });
        }
        case 'appendText': {
            const index = snapshot.items.findIndex((item) => item.id === operation.itemId);
            if (index === -1) return snapshot;
            const items = [...snapshot.items];
            items[index] = appendToItem(snapshot.items[index], operation.delta);
            // Streaming grows the aggregate as surely as an upsert does, so the budget holds mid-stream too.
            return enforceBudget({ ...snapshot, items });
        }
        case 'state': {
            const next: AgentChatSnapshot = { ...snapshot };
            const { state } = operation;
            if (state.status !== undefined) next.status = state.status;
            if (state.turns !== undefined) next.turns = state.turns;
            if (state.requests !== undefined) next.requests = state.requests;
            if (state.truncated !== undefined) next.truncated = state.truncated;
            if (state.failure !== undefined) next.failure = state.failure ?? undefined;
            if (state.activeTurnId !== undefined)
                next.activeTurnId = state.activeTurnId ?? undefined;
            if (state.plan !== undefined) next.plan = state.plan ?? undefined;
            if (state.model !== undefined) next.model = state.model ?? undefined;
            if (state.usage !== undefined) next.usage = state.usage ?? undefined;
            if (state.commands !== undefined) next.commands = state.commands;
            for (const key of ['failure', 'activeTurnId', 'plan', 'model', 'usage'] as const)
                if (next[key] === undefined) delete next[key];
            return next;
        }
    }
}

/**
 * Applies a patch when it continues `snapshot`; returns `undefined` when the Client missed a revision and must re-read.
 */
export function applyAgentChatPatch(
    snapshot: AgentChatSnapshot,
    patch: {
        baseRevision: number;
        revision: number;
        operations: readonly AgentChatPatchOperation[];
    },
): AgentChatSnapshot | undefined {
    if (patch.baseRevision !== snapshot.revision) return undefined;
    let next = snapshot;
    for (const operation of patch.operations) next = applyAgentChatOperation(next, operation);
    return { ...next, revision: patch.revision };
}

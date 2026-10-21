import type {
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatSnapshot,
} from './agent-chat-contract.js';
import {
    MAX_AGENT_CHAT_ITEMS,
    MAX_AGENT_CHAT_OUTPUT_LENGTH,
    MAX_AGENT_CHAT_TASK_ITEMS,
    MAX_AGENT_CHAT_TASK_TOTAL_TEXT_LENGTH,
    MAX_AGENT_CHAT_TEXT_LENGTH,
    MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH,
} from './agent-chat-limits.js';
import type {
    AgentChatTaskPatchOperation,
    AgentChatTaskSnapshot,
} from './agent-chat-task-contract.js';

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

/**
 * What one item counts against the projection's aggregate text budget.
 */
export function agentChatItemTextLength(item: AgentChatItem): number {
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
            return (
                (item.summary?.length ?? 0) + (item.input?.length ?? 0) + (item.output?.length ?? 0)
            );
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
 * The newest items that fit a count and text budget, always keeping the newest one.
 */
function budgetItems(
    items: AgentChatItem[],
    maxItems: number,
    maxText: number,
): { items: AgentChatItem[]; isTruncated: boolean } {
    let kept = items;
    let isTruncated = false;
    if (kept.length > maxItems) {
        kept = kept.slice(kept.length - maxItems);
        isTruncated = true;
    }
    let total = 0;
    for (const item of kept) total += agentChatItemTextLength(item);
    let dropCount = 0;
    while (total > maxText && dropCount < kept.length - 1) {
        total -= agentChatItemTextLength(kept[dropCount]);
        dropCount += 1;
    }
    if (dropCount > 0) {
        kept = kept.slice(dropCount);
        isTruncated = true;
    }
    return { items: kept, isTruncated };
}

/**
 * Drops the oldest items until the projection fits its count and text budgets.
 */
function enforceBudget(snapshot: AgentChatSnapshot): AgentChatSnapshot {
    const budgeted = budgetItems(
        snapshot.items,
        MAX_AGENT_CHAT_ITEMS,
        MAX_AGENT_CHAT_TOTAL_TEXT_LENGTH,
    );
    const { items } = budgeted;
    if (items === snapshot.items) return snapshot;
    const isTruncated = snapshot.truncated || budgeted.isTruncated;
    const turnIds = new Set(items.map((item) => item.turnId).filter(Boolean));
    const turns = snapshot.turns.filter(
        (turn) => turnIds.has(turn.id) || turn.id === snapshot.activeTurnId,
    );
    return { ...snapshot, items, turns, truncated: isTruncated };
}

/**
 * Providers re-upsert an item whole as it progresses and never repeat when it began, so a replacement keeps the time
 * the first upsert recorded.
 */
function withCreatedAt<T extends AgentChatItem>(item: T, previous: AgentChatItem): T {
    if (item.createdAt !== undefined || previous.createdAt === undefined) return item;
    return { ...item, createdAt: previous.createdAt };
}

/**
 * Progress after a retry settles its notice. Any assistant, thought, or tool item of the same turn means the provider
 * got a response again, so the turn's unresolved `retrying` notice is marked `resolved` (in place, on the array the
 * caller owns). A retry upsert itself, the user's message, and other notices are not progress. Providers (Claude Code
 * and Codex) share this because they all emit the same notice shape.
 */
function resolveRetries(items: AgentChatItem[], progress: AgentChatItem): AgentChatItem[] {
    if (!progress.turnId || progress.type === 'userMessage' || progress.type === 'notice') {
        return items;
    }
    // Only an item after the notice is progress since the retry: an older tool that started before the outage can still
    // stream output or settle while the provider is retrying.
    const progressIndex = items.findIndex((item) => item.id === progress.id);
    for (const [index, item] of items.entries()) {
        if (
            index < progressIndex &&
            item.type === 'notice' &&
            item.kind === 'retrying' &&
            item.retry &&
            !item.retry.resolved &&
            item.turnId === progress.turnId
        ) {
            items[index] = { ...item, retry: { ...item.retry, resolved: true } };
        }
    }
    return items;
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
            /**
             * Commands, models, and MCP servers describe the running provider, and the follow-up queue belongs to
             * Server Core; none is part of the conversation being replaced. A resumed Claude Code reports its models
             * before its history replay resets the Chat, so dropping them here hid the model picker on every resumed
             * Chat.
             */
            return {
                ...emptyAgentChatSnapshot(snapshot.terminalId),
                revision: snapshot.revision,
                ...(snapshot.commands && { commands: snapshot.commands }),
                ...(snapshot.models && { models: snapshot.models }),
                ...(snapshot.mcpServers && { mcpServers: snapshot.mcpServers }),
                ...(snapshot.queue && { queue: snapshot.queue }),
                ...(snapshot.queueLength !== undefined && { queueLength: snapshot.queueLength }),
                ...(snapshot.queuePaused !== undefined && { queuePaused: snapshot.queuePaused }),
                ...(snapshot.queuePauseReason && { queuePauseReason: snapshot.queuePauseReason }),
            };
        }
        case 'upsertItem': {
            const index = snapshot.items.findIndex((item) => item.id === operation.item.id);
            const items = [...snapshot.items];
            if (index === -1) items.push(operation.item);
            else items[index] = withCreatedAt(operation.item, snapshot.items[index]);
            return enforceBudget({ ...snapshot, items: resolveRetries(items, operation.item) });
        }
        case 'appendText': {
            const index = snapshot.items.findIndex((item) => item.id === operation.itemId);
            if (index === -1) return snapshot;
            const items = [...snapshot.items];
            items[index] = appendToItem(snapshot.items[index], operation.delta);
            resolveRetries(items, items[index]);
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
            if (state.historyId !== undefined) next.historyId = state.historyId;
            if (state.failure !== undefined) next.failure = state.failure ?? undefined;
            if (state.activeTurnId !== undefined)
                next.activeTurnId = state.activeTurnId ?? undefined;
            if (state.plan !== undefined) next.plan = state.plan ?? undefined;
            if (state.goal !== undefined) next.goal = state.goal ?? undefined;
            if (state.model !== undefined) next.model = state.model ?? undefined;
            if (state.effort !== undefined) next.effort = state.effort ?? undefined;
            if (state.ultracode !== undefined) next.ultracode = state.ultracode ?? undefined;
            if (state.fast !== undefined) next.fast = state.fast ?? undefined;
            if (state.permissionMode !== undefined)
                next.permissionMode = state.permissionMode ?? undefined;
            if (state.planMode !== undefined) next.planMode = state.planMode ?? undefined;
            if (state.models !== undefined) next.models = state.models;
            if (state.usage !== undefined) next.usage = state.usage ?? undefined;
            if (state.turnUsage !== undefined) next.turnUsage = state.turnUsage ?? undefined;
            if (state.commands !== undefined) next.commands = state.commands;
            if (state.mcpServers !== undefined) next.mcpServers = state.mcpServers;
            if (state.operation !== undefined) next.operation = state.operation ?? undefined;
            if (state.tasks !== undefined) next.tasks = state.tasks;
            if (state.queue !== undefined) next.queue = state.queue;
            if (state.queueLength !== undefined) next.queueLength = state.queueLength;
            if (state.queuePaused !== undefined) next.queuePaused = state.queuePaused;
            if (state.queuePauseReason !== undefined)
                next.queuePauseReason = state.queuePauseReason ?? undefined;
            for (const key of [
                'failure',
                'activeTurnId',
                'plan',
                'goal',
                'model',
                'effort',
                'ultracode',
                'fast',
                'permissionMode',
                'planMode',
                'usage',
                'turnUsage',
                'operation',
                'queuePauseReason',
            ] as const)
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

/**
 * Empty projection for a task whose provider has not reported any of its content yet.
 */
export function emptyAgentChatTaskSnapshot(
    terminalId: string,
    taskId: string,
): AgentChatTaskSnapshot {
    return { terminalId, taskId, revision: 0, truncated: false, items: [] };
}

function enforceTaskBudget(snapshot: AgentChatTaskSnapshot): AgentChatTaskSnapshot {
    const budgeted = budgetItems(
        snapshot.items,
        MAX_AGENT_CHAT_TASK_ITEMS,
        MAX_AGENT_CHAT_TASK_TOTAL_TEXT_LENGTH,
    );
    if (budgeted.items === snapshot.items) return snapshot;
    return {
        ...snapshot,
        items: budgeted.items,
        truncated: snapshot.truncated || budgeted.isTruncated,
    };
}

/**
 * Applies one task patch operation, shared by Server Core and every Client like {@link applyAgentChatOperation}.
 */
export function applyAgentChatTaskOperation(
    snapshot: AgentChatTaskSnapshot,
    operation: AgentChatTaskPatchOperation,
): AgentChatTaskSnapshot {
    switch (operation.op) {
        case 'reset': {
            return {
                ...emptyAgentChatTaskSnapshot(snapshot.terminalId, snapshot.taskId),
                revision: snapshot.revision,
            };
        }
        case 'upsertItem': {
            const index = snapshot.items.findIndex((item) => item.id === operation.item.id);
            const items = [...snapshot.items];
            if (index === -1) items.push(operation.item);
            else items[index] = operation.item;
            return enforceTaskBudget({ ...snapshot, items });
        }
        case 'appendText': {
            const index = snapshot.items.findIndex((item) => item.id === operation.itemId);
            if (index === -1) return snapshot;
            const items = [...snapshot.items];
            items[index] = appendToItem(snapshot.items[index], operation.delta);
            return enforceTaskBudget({ ...snapshot, items });
        }
        case 'appendOutput': {
            return {
                ...snapshot,
                output: appendBounded(
                    snapshot.output ?? '',
                    operation.delta,
                    'tail',
                    MAX_AGENT_CHAT_OUTPUT_LENGTH,
                ),
            };
        }
        case 'state': {
            const next: AgentChatTaskSnapshot = { ...snapshot };
            const { state } = operation;
            if (state.output !== undefined) next.output = state.output;
            if (state.isOutputCapped !== undefined) next.isOutputCapped = state.isOutputCapped;
            if (state.truncated !== undefined) next.truncated = state.truncated;
            return next;
        }
    }
}

/**
 * Applies a task patch when it continues `snapshot`; returns `undefined` when the Client must re-read.
 */
export function applyAgentChatTaskPatch(
    snapshot: AgentChatTaskSnapshot,
    patch: {
        baseRevision: number;
        revision: number;
        operations: readonly AgentChatTaskPatchOperation[];
    },
): AgentChatTaskSnapshot | undefined {
    if (patch.baseRevision !== snapshot.revision) return undefined;
    let next = snapshot;
    for (const operation of patch.operations) next = applyAgentChatTaskOperation(next, operation);
    return { ...next, revision: patch.revision };
}

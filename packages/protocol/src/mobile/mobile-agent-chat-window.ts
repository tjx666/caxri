import type { AgentChatItem, AgentChatSnapshot } from '../agent/agent-chat-contract.js';
import type {
    AgentChatHistoryPage,
    AgentChatPatch,
    AgentChatPatchOperation,
} from '../agent/agent-chat-patch-contract.js';
import type { AgentChatTaskSnapshot } from '../agent/agent-chat-task-contract.js';
import { projectDisplayPath } from '../domain/project-path.js';
import {
    clipAgentChatStateForMobile,
    MOBILE_AGENT_CHAT_CLIP_MARKER,
} from './mobile-agent-chat-state-clip.js';

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

const keepTail = (text: string, limit = MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH): string =>
    text.length <= limit ? text : `${MOBILE_AGENT_CHAT_CLIP_MARKER}${text.slice(-limit)}`;

const keepHead = (text: string, limit = MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH): string =>
    text.length <= limit ? text : `${text.slice(0, limit)}\n${MOBILE_AGENT_CHAT_CLIP_MARKER}`;

/**
 * A file change's paths as Desktop names them, Project-relative inside the Session's Project. The Server relativizes
 * them because a paired device is never told a Project's root path (`scopedProjectSchema`).
 */
function withProjectPaths(item: AgentChatItem, projectRoot: string | undefined): AgentChatItem {
    if (projectRoot === undefined || item.type !== 'fileChange') return item;
    const changes = item.changes.map((change) => {
        const path = projectDisplayPath(change.path, projectRoot);
        return path === change.path ? change : { ...change, path };
    });
    return changes.some((change, index) => change !== item.changes[index])
        ? { ...item, changes }
        : item;
}

/**
 * Shortens one item to what a phone can carry, naming changed files relative to `projectRoot`, the Session's Project
 * root. Deterministic, so the snapshot window and later `upsertItem` patches agree on the same item.
 */
export function clipAgentChatItemForMobile(
    original: AgentChatItem,
    projectRoot?: string,
): AgentChatItem {
    const item = withProjectPaths(original, projectRoot);
    switch (item.type) {
        case 'userMessage': {
            const text =
                item.text.length <= MOBILE_AGENT_CHAT_FIELD_MAX_LENGTH
                    ? item.text
                    : keepTail(item.text);
            /**
             * A Desktop thumbnail may take 48 KiB, so a few would fill the whole frame and push the message and all
             * older history out of the window. The phone keeps each image's place and fetches its thumbnail on demand
             * through `mobile.agentChat.readImage`.
             */
            const hasThumbnail =
                item.images?.some((image) => image.thumbnail !== undefined) ?? false;
            if (!hasThumbnail && text === item.text) return item;
            return {
                ...item,
                text,
                ...(item.images && { images: item.images.map(() => ({})) }),
            };
        }
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
                return {
                    ...change,
                    diff: limit > 0 ? keepHead(change.diff, limit) : '',
                    truncated: true,
                };
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
 * How many of `items` (from the end) fit `budget` bytes, newest first, as the index of the oldest one kept.
 */
function newestFittingStart(items: readonly AgentChatItem[], budget: number): number {
    let remaining = budget;
    let start = items.length;
    while (start > 0) {
        const cost = byteLength(items[start - 1]) + 1;
        if (cost > remaining) break;
        remaining -= cost;
        start -= 1;
    }
    return start;
}

/**
 * The newest part of a Chat projection that fits one mobile frame. Older items are dropped first and `truncated` is
 * set, the same signal the Desktop projection uses for history it no longer holds. The phone reads what this window
 * dropped, and everything older, a page at a time through `mobile.agentChat.readHistory`, each page cut by
 * {@link windowAgentChatHistoryPageForMobile}.
 */
export function windowAgentChatSnapshotForMobile(
    full: AgentChatSnapshot,
    projectRoot?: string,
): AgentChatSnapshot {
    const snapshot = clipAgentChatStateForMobile(full);
    const items = snapshot.items.map((item) => clipAgentChatItemForMobile(item, projectRoot));
    const activeTurnIds = (kept: readonly AgentChatItem[]) =>
        new Set([
            ...kept.map((item) => item.turnId).filter(Boolean),
            ...(snapshot.activeTurnId ? [snapshot.activeTurnId] : []),
        ]);
    const shell: AgentChatSnapshot = { ...snapshot, items: [], turns: [] };
    const start = newestFittingStart(items, MOBILE_AGENT_CHAT_MAX_BYTES - byteLength(shell));
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

/**
 * The newest part of a history page (from `agentChat.readHistory`, or a slice of the projection older than the phone's
 * window) that fits one mobile frame, each item clipped like the window's. When items are dropped `hasMore` is set and
 * the oldest item kept becomes the phone's next cursor, so nothing is skipped: the dropped items arrive on the next
 * page. The page keeps only the turns its items reference.
 */
export function windowAgentChatHistoryPageForMobile(
    page: AgentChatHistoryPage,
    projectRoot?: string,
): AgentChatHistoryPage {
    const items = page.items.map((item) => clipAgentChatItemForMobile(item, projectRoot));
    const shell: AgentChatHistoryPage = { ...page, items: [], turns: [] };
    const start = newestFittingStart(items, MOBILE_AGENT_CHAT_MAX_BYTES - byteLength(shell));
    const referencedTurns = (kept: readonly AgentChatItem[]) => {
        const turnIds = new Set(kept.map((item) => item.turnId));
        return page.turns.filter((turn) => turnIds.has(turn.id));
    };
    const windowed: AgentChatHistoryPage = {
        ...page,
        items: items.slice(start),
        turns: referencedTurns(items.slice(start)),
        hasMore: page.hasMore || start > 0,
    };
    // Turns are small but unbounded by the budget above; drop the oldest items again if they tipped it.
    while (windowed.items.length > 1 && byteLength(windowed) > MOBILE_AGENT_CHAT_MAX_BYTES) {
        windowed.items = windowed.items.slice(1);
        windowed.turns = referencedTurns(windowed.items);
        windowed.hasMore = true;
    }
    return windowed;
}

function clipOperation(
    operation: AgentChatPatchOperation,
    projectRoot: string | undefined,
): AgentChatPatchOperation {
    switch (operation.op) {
        case 'upsertItem': {
            return {
                op: 'upsertItem',
                item: clipAgentChatItemForMobile(operation.item, projectRoot),
            };
        }
        case 'state': {
            return { op: 'state', state: clipAgentChatStateForMobile(operation.state) };
        }
        default: {
            return operation;
        }
    }
}

/**
 * The patch a phone receives, or `undefined` when even the shortened patch would not fit one frame. The gateway then
 * sends a content-free change notice and the phone re-reads its window instead.
 */
export function clipAgentChatPatchForMobile(
    patch: AgentChatPatch,
    projectRoot?: string,
): AgentChatPatch | undefined {
    const clipped: AgentChatPatch = {
        ...patch,
        operations: patch.operations.map((operation) => clipOperation(operation, projectRoot)),
    };
    return byteLength(clipped) <= MOBILE_AGENT_CHAT_MAX_BYTES ? clipped : undefined;
}

/**
 * The most of a background shell's output tail one `mobile.agentChat.readTask` reply carries, measured as it travels
 * (JSON-escaped UTF-8), so a terminal full of escape codes or wide characters still fits the frame.
 */
export const MOBILE_AGENT_CHAT_TASK_OUTPUT_MAX_BYTES = 24 * 1_024;

/**
 * The newest part of one task's projection that fits one mobile frame: a shell's output keeps its tail within
 * {@link MOBILE_AGENT_CHAT_TASK_OUTPUT_MAX_BYTES}, and a subagent's conversation keeps its newest items, each shortened
 * like the Chat's own, with `truncated` set once older ones are dropped.
 */
export function clipAgentChatTaskSnapshotForMobile(
    full: AgentChatTaskSnapshot,
    projectRoot?: string,
): AgentChatTaskSnapshot {
    let output = full.output;
    if (output !== undefined) {
        let limit = MOBILE_AGENT_CHAT_TASK_OUTPUT_MAX_BYTES;
        output = keepTail(output, limit);
        while (byteLength(output) > MOBILE_AGENT_CHAT_TASK_OUTPUT_MAX_BYTES) {
            limit = Math.floor(limit * 0.75);
            output = keepTail(output, limit);
        }
    }
    const shell: AgentChatTaskSnapshot = {
        ...full,
        items: [],
        ...(output !== undefined && { output }),
    };
    const items = full.items.map((item) => clipAgentChatItemForMobile(item, projectRoot));
    let budget = MOBILE_AGENT_CHAT_MAX_BYTES - byteLength(shell);
    let start = items.length;
    while (start > 0) {
        const cost = byteLength(items[start - 1]) + 1;
        if (cost > budget) break;
        budget -= cost;
        start -= 1;
    }
    return { ...shell, items: items.slice(start), truncated: full.truncated || start > 0 };
}

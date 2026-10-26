import type {
    AgentChatItem,
    AgentChatSnapshot,
    AgentTimelineItem,
    DeviceStoreEntry,
    MobileDashboardResult,
} from '@caxri/protocol';
import {
    agentChatSnapshotSchema,
    agentTimelineItemSchema,
    decodeDeviceStoreEntry,
    encodeDeviceStoreEntry,
    findAgentChatModel,
    mobileDashboardResultSchema,
} from '@caxri/protocol';
import { z } from 'zod';

/**
 * Bumped when a cached shape changes; an entry written by another version is dropped instead of migrated.
 */
export const READ_CACHE_VERSION = 1;

/**
 * The newest messages a Conversation or Chat keeps on the phone, as Paseo keeps 50 per agent.
 */
export const READ_CACHE_MAX_ITEMS = 50;

/**
 * Conversations and Chats kept at once; the least recently saved go first.
 */
export const READ_CACHE_MAX_CONVERSATIONS = 20;

export type ReadCacheKey =
    | { kind: 'dashboard' }
    | { kind: 'drafts' }
    | { kind: 'timeline'; sessionId: string }
    | { kind: 'chat'; terminalId: string };

export type ReadCacheEntry<Value> = DeviceStoreEntry<Value>;

export const readCacheFileName = (key: ReadCacheKey): string => {
    switch (key.kind) {
        case 'dashboard': {
            return 'dashboard.json';
        }
        case 'drafts': {
            return 'drafts.json';
        }
        case 'timeline': {
            return `timeline-${encodeURIComponent(key.sessionId)}.json`;
        }
        case 'chat': {
            return `chat-${encodeURIComponent(key.terminalId)}.json`;
        }
    }
};

export const isConversationCacheFile = (name: string): boolean =>
    name.startsWith('timeline-') || name.startsWith('chat-');

export const encodeReadCacheEntry = (scope: string, savedAt: number, value: unknown): string =>
    encodeDeviceStoreEntry(READ_CACHE_VERSION, scope, savedAt, value);

/**
 * An entry for this pairing, or `null` for a corrupt, foreign, or older-version file.
 */
export const decodeReadCacheEntry = <Value>(
    text: string,
    scope: string,
    valueSchema: z.ZodType<Value>,
): ReadCacheEntry<Value> | null =>
    decodeDeviceStoreEntry(text, READ_CACHE_VERSION, scope, valueSchema);

/**
 * The scope a live read may be saved under: the pairing it was read under, and only while that pairing is still
 * current. A Chat or Conversation read under the previous pairing can stay in state for a render after the scope
 * changes; saving it under the new scope would show one computer's content as another's saved copy.
 */
export const liveReadSaveScope = (
    readScope: string | undefined,
    currentScope: string | null,
): string | null => (readScope !== undefined && readScope === currentScope ? readScope : null);

export const cachedDashboardSchema: z.ZodType<MobileDashboardResult> = mobileDashboardResultSchema;

/**
 * Output and details are Terminal output by another name, so only the line a row shows survives.
 */
export const trimTimelineItems = (items: readonly AgentTimelineItem[]): AgentTimelineItem[] =>
    items.slice(-READ_CACHE_MAX_ITEMS).map((item) => {
        if (item.type !== 'toolCall' && item.type !== 'systemEvent') return item;
        const rest = { ...item };
        delete rest.detail;
        return rest;
    });

export const cachedTimelineSchema = z.strictObject({
    items: z.array(agentTimelineItemSchema).max(READ_CACHE_MAX_ITEMS),
    truncated: z.boolean(),
});

/**
 * Keeps what a reader needs to recognize the work: messages, reasoning, and each tool's one-line identity. Command and
 * tool output, file diffs, and image previews stay on the computer, like source and Terminal output stay out of logs.
 */
const trimChatItem = (item: AgentChatItem): AgentChatItem => {
    switch (item.type) {
        case 'userMessage': {
            return item.images ? { ...item, images: item.images.map(() => ({})) } : item;
        }
        case 'command': {
            return { ...item, output: '' };
        }
        case 'fileChange': {
            return { ...item, changes: item.changes.map((change) => ({ ...change, diff: '' })) };
        }
        case 'toolCall': {
            const rest = { ...item };
            delete rest.output;
            return rest;
        }
        default: {
            return item;
        }
    }
};

/**
 * The newest items of a Chat that fit the cache, cut at a turn boundary: a turn the limit would split is left out whole
 * unless it is the only one. A split turn opened from the saved copy without the files and pull requests its cut start
 * held, and its cards then popped in mid-list when the live read arrived.
 */
const newestWholeTurns = (items: readonly AgentChatItem[]): readonly AgentChatItem[] => {
    const kept = items.slice(-READ_CACHE_MAX_ITEMS);
    if (kept.length === items.length) return kept;
    const splitTurnId = items[items.length - kept.length - 1]?.turnId;
    const start = kept.findIndex((item) => item.turnId !== splitTurnId);
    return start === -1 ? kept : kept.slice(start);
};

/**
 * A Chat as the phone last saw it, without pending approvals: those can only be answered live. Of the provider's model
 * list it keeps only the model in use, so the composer still names it as Desktop does (`Fake Codex`, not its id), and
 * it keeps ultracode, the permission level, and plan mode, so an offline composer still shows them read-only.
 */
export const trimChatSnapshot = (snapshot: AgentChatSnapshot): AgentChatSnapshot => {
    const items = newestWholeTurns(snapshot.items).map(trimChatItem);
    const turnIds = new Set(items.map((item) => item.turnId));
    const model = findAgentChatModel(snapshot.models, snapshot.model);
    return {
        terminalId: snapshot.terminalId,
        revision: snapshot.revision,
        status: snapshot.status,
        ...(snapshot.failure && { failure: snapshot.failure }),
        truncated: snapshot.truncated || items.length < snapshot.items.length,
        items,
        turns: snapshot.turns.filter((turn) => turnIds.has(turn.id)),
        requests: [],
        ...(snapshot.model !== undefined && { model: snapshot.model }),
        ...(model && { models: [model] }),
        ...(snapshot.effort !== undefined && { effort: snapshot.effort }),
        ...(snapshot.ultracode !== undefined && { ultracode: snapshot.ultracode }),
        ...(snapshot.permissionMode !== undefined && { permissionMode: snapshot.permissionMode }),
        ...(snapshot.planMode !== undefined && { planMode: snapshot.planMode }),
    };
};

export const cachedChatSchema: z.ZodType<AgentChatSnapshot> = agentChatSnapshotSchema;

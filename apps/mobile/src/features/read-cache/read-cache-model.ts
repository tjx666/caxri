import type {
    AgentChatItem,
    AgentChatSnapshot,
    AgentTimelineItem,
    MobileDashboardResult,
} from '@caxri/protocol';
import {
    agentChatSnapshotSchema,
    agentTimelineItemSchema,
    findAgentChatModel,
    mobileDashboardResultSchema,
} from '@caxri/protocol';
import { z } from 'zod';

/**
 * Bumped when a cached shape changes; an entry written by another version is dropped instead of migrated.
 */
const READ_CACHE_VERSION = 1;

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
    | { kind: 'timeline'; sessionId: string }
    | { kind: 'chat'; terminalId: string };

export interface ReadCacheEntry<Value> {
    savedAt: number;
    value: Value;
}

export const readCacheFileName = (key: ReadCacheKey): string => {
    switch (key.kind) {
        case 'dashboard': {
            return 'dashboard.json';
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

const envelopeSchema = z.strictObject({
    version: z.literal(READ_CACHE_VERSION),
    /**
     * The pairing identity (server, device, generation) the entry was read under; never the device key.
     */
    scope: z.string().min(1),
    savedAt: z.number().int().nonnegative(),
    value: z.unknown(),
});

export const encodeReadCacheEntry = (scope: string, savedAt: number, value: unknown): string =>
    JSON.stringify({ version: READ_CACHE_VERSION, scope, savedAt, value });

/**
 * An entry for this pairing, or `null` for a corrupt, foreign, or older-version file.
 */
export const decodeReadCacheEntry = <Value>(
    text: string,
    scope: string,
    valueSchema: z.ZodType<Value>,
): ReadCacheEntry<Value> | null => {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success || envelope.data.scope !== scope) return null;
    const value = valueSchema.safeParse(envelope.data.value);
    return value.success ? { savedAt: envelope.data.savedAt, value: value.data } : null;
};

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
 * A Chat as the phone last saw it, without pending approvals: those can only be answered live. Of the provider's model
 * list it keeps only the model in use, so the composer still names it as Desktop does (`Fake Codex`, not its id).
 */
export const trimChatSnapshot = (snapshot: AgentChatSnapshot): AgentChatSnapshot => {
    const items = snapshot.items.slice(-READ_CACHE_MAX_ITEMS).map(trimChatItem);
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
    };
};

export const cachedChatSchema: z.ZodType<AgentChatSnapshot> = agentChatSnapshotSchema;

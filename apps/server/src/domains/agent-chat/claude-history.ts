import type {
    AgentChatImageInput,
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatPlan,
    AgentChatTaskPatchOperation,
    AgentChatTurn,
} from '@caxri/protocol';
import {
    agentChatImageInputSchema,
    MAX_AGENT_CHAT_TASK_ITEMS,
    MAX_AGENT_CHAT_TEXT_LENGTH,
} from '@caxri/protocol';

import { extractVisibleTranscriptMessage } from '../agents';
import { clip, closeDanglingItem, isRecord, stringField } from './chat-items';
import { claudeUserImageCount, isClaudeCompactCommand } from './claude-input';
import { claudeAssistantItems, ClaudeBlockIds, text } from './claude-items';
import { settleClaudeToolItem } from './claude-tool-results';

/**
 * Rebuilds a resumed Claude Code Chat from its session JSONL transcript. Claude Code's resume returns no history, so
 * the transcript tail is the only record of earlier turns. Inputs are untrusted JSON.
 */

type Json = Record<string, unknown>;

/**
 * History loaded on resume is capped by turns; the shared reducer also enforces the item and byte budgets.
 */
const MAX_RESUMED_TURNS = 100;

interface HistoryState {
    /**
     * Reads a subagent's own transcript, whose records are all sidechain records.
     */
    isSidechain: boolean;
    ids: ClaudeBlockIds;
    turns: AgentChatTurn[];
    items: Map<string, AgentChatItem>;
    turnId?: string;
    plan?: AgentChatPlan;
}

function parseRecord(line: string): Json | undefined {
    if (!line.trim()) return undefined;
    try {
        const record: unknown = JSON.parse(line);
        return isRecord(record) ? record : undefined;
    } catch {
        return undefined;
    }
}

function applySystemRecord(state: HistoryState, record: Json): void {
    const { turnId } = state;
    if (record.subtype === 'compact_boundary') {
        const id = clip(`compact:${text(record.uuid)}`, 200);
        state.items.set(id, { id, ...(turnId && { turnId }), type: 'notice', kind: 'compacted' });
        return;
    }
    if (record.subtype !== 'turn_duration') return;
    const current = state.turns.at(-1);
    const { durationMs } = record;
    if (current && typeof durationMs === 'number' && durationMs >= 0)
        current.durationMs = durationMs;
}

function applyUserRecord(state: HistoryState, record: Json, message: Json): void {
    const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    for (const block of blocks) {
        const toolUseId = block.type === 'tool_result' ? stringField(block.tool_use_id) : undefined;
        const item = toolUseId ? state.items.get(clip(toolUseId, 200)) : undefined;
        const settled =
            item && settleClaudeToolItem(item, block, { structured: record.toolUseResult });
        if (settled) state.items.set(settled.id, settled);
    }
    if (record.isCompactSummary === true) return;
    // The shared extractor ignores sidechain records; a subagent transcript consists of nothing else.
    const visible = extractVisibleTranscriptMessage(
        state.isSidechain ? { ...record, isSidechain: false } : record,
    );
    const uuid = stringField(record.uuid);
    // An image-only message has no visible text but is still the user's turn.
    const imageCount = claudeUserImageCount(message.content);
    if (!uuid || (imageCount === 0 && visible?.role !== 'user')) return;
    const turnId = clip(uuid, 200);
    state.turnId = turnId;
    state.turns.push({ id: turnId, status: 'completed' });
    // The compaction notice already stands for `/compact`; the live Chat hides its bubble too.
    if (imageCount === 0 && visible && isClaudeCompactCommand(visible.text)) return;
    state.items.set(turnId, {
        id: turnId,
        turnId,
        type: 'userMessage',
        text: clip(visible?.text ?? '', MAX_AGENT_CHAT_TEXT_LENGTH),
        ...(imageCount > 0 && { images: Array.from({ length: imageCount }, () => ({})) }),
    });
}

function applyHistoryRecord(state: HistoryState, record: Json): void {
    if (record.isMeta === true || (record.isSidechain === true && !state.isSidechain)) return;
    if (record.type === 'system') {
        applySystemRecord(state, record);
        return;
    }
    const message = isRecord(record.message) ? record.message : undefined;
    if (!message) return;
    if (record.type === 'assistant') {
        const mapped = claudeAssistantItems(message, state.turnId, state.ids);
        for (const item of mapped.items) state.items.set(item.id, item);
        if (mapped.plan) state.plan = mapped.plan;
    } else if (record.type === 'user') applyUserRecord(state, record, message);
}

function readHistory(transcript: string, isSidechain: boolean): HistoryState {
    const state: HistoryState = {
        isSidechain,
        ids: new ClaudeBlockIds(),
        turns: [],
        items: new Map(),
    };
    for (const line of transcript.split('\n')) {
        const record = parseRecord(line);
        if (record) applyHistoryRecord(state, record);
    }
    return state;
}

/**
 * Operations that replace the projection with a resumed Claude Code session, read from the tail of its JSONL
 * transcript. Sidechains (subagents) and injected harness records are skipped; a visible user prompt opens a turn.
 * Every resumed turn is finished: a resume never re-enters a turn the previous process was running.
 */
export function claudeHistoryOperations(
    transcript: string,
    isTailTruncated: boolean,
): AgentChatPatchOperation[] {
    const state = readHistory(transcript, false);
    const { turns, items, plan } = state;
    const keptTurns = turns.slice(-MAX_RESUMED_TURNS);
    const droppedTurns = new Set(
        turns.slice(0, turns.length - keptTurns.length).map((turn) => turn.id),
    );
    const operations: AgentChatPatchOperation[] = [{ op: 'reset' }];
    for (const item of items.values()) {
        if (item.turnId && droppedTurns.has(item.turnId)) continue;
        operations.push({ op: 'upsertItem', item: closeDanglingItem(item) ?? item });
    }
    operations.push({
        op: 'state',
        state: {
            turns: keptTurns,
            activeTurnId: null,
            ...((isTailTruncated || droppedTurns.size > 0) && { truncated: true }),
            ...(plan && { plan }),
        },
    });
    return operations;
}

/**
 * Operations that rebuild one subagent's task projection from its own JSONL transcript (Claude Code writes it beside
 * the session transcript). The subagent's prompt opens it as a user message; turn ids are dropped because a task
 * projection has no turns. Only the newest {@link MAX_AGENT_CHAT_TASK_ITEMS} items are kept.
 */
export function claudeTaskHistoryOperations(
    transcript: string,
    isTailTruncated: boolean,
): AgentChatTaskPatchOperation[] {
    const { items } = readHistory(transcript, true);
    const all = items
        .values()
        .map((item): AgentChatItem => {
            const settled = closeDanglingItem(item) ?? item;
            return Object.fromEntries(
                Object.entries(settled).filter(([key]) => key !== 'turnId'),
            ) as AgentChatItem;
        })
        .toArray();
    const kept = all.slice(-MAX_AGENT_CHAT_TASK_ITEMS);
    return [
        { op: 'reset' },
        ...kept.map((item) => ({ op: 'upsertItem' as const, item })),
        ...(isTailTruncated || kept.length < all.length
            ? [{ op: 'state' as const, state: { truncated: true } }]
            : []),
    ];
}

const storedImageSchema = agentChatImageInputSchema.omit({ thumbnail: true });

/**
 * The `index`th image of the user message whose record `uuid` is `itemId` (the id `applyUserRecord` gives it), as the
 * transcript stores it; `undefined` when the transcript no longer holds that message or image. Only a line naming the
 * id is parsed, so finding one message does not decode every image in the transcript.
 */
export function claudeHistoryImage(
    transcript: string,
    itemId: string,
    index: number,
): Omit<AgentChatImageInput, 'thumbnail'> | undefined {
    for (const line of transcript.split('\n')) {
        if (!line.includes(itemId)) continue;
        const record = parseRecord(line);
        if (record?.type !== 'user' || stringField(record.uuid) !== itemId) continue;
        const message = isRecord(record.message) ? record.message : undefined;
        const images = Array.isArray(message?.content)
            ? message.content.filter((block) => isRecord(block) && block.type === 'image')
            : [];
        const source: unknown = (images[index] as Json | undefined)?.source;
        if (!isRecord(source) || source.type !== 'base64') return undefined;
        const parsed = storedImageSchema.safeParse({
            mediaType: source.media_type,
            data: source.data,
        });
        return parsed.success ? parsed.data : undefined;
    }
    return undefined;
}

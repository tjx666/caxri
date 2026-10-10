import type {
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatPlan,
    AgentChatTurn,
} from '@caxri/protocol';
import { MAX_AGENT_CHAT_TEXT_LENGTH } from '@caxri/protocol';

import { extractVisibleTranscriptMessage } from '../agents';
import { clip, closeDanglingItem, isRecord, stringField } from './chat-items';
import { claudeUserImageCount } from './claude-input';
import { claudeAssistantItems, ClaudeBlockIds, settleClaudeToolItem, text } from './claude-items';

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
        const settled = item && settleClaudeToolItem(item, block, record.toolUseResult, false);
        if (settled) state.items.set(settled.id, settled);
    }
    if (record.isCompactSummary === true) return;
    const visible = extractVisibleTranscriptMessage(record);
    const uuid = stringField(record.uuid);
    // An image-only message has no visible text but is still the user's turn.
    const imageCount = claudeUserImageCount(message.content);
    if (!uuid || (imageCount === 0 && visible?.role !== 'user')) return;
    const turnId = clip(uuid, 200);
    state.turnId = turnId;
    state.turns.push({ id: turnId, status: 'completed' });
    state.items.set(turnId, {
        id: turnId,
        turnId,
        type: 'userMessage',
        text: clip(visible?.text ?? '', MAX_AGENT_CHAT_TEXT_LENGTH),
        ...(imageCount > 0 && { images: Array.from({ length: imageCount }, () => ({})) }),
    });
}

function applyHistoryRecord(state: HistoryState, record: Json): void {
    if (record.isSidechain === true || record.isMeta === true) return;
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

/**
 * Operations that replace the projection with a resumed Claude Code session, read from the tail of its JSONL
 * transcript. Sidechains (subagents) and injected harness records are skipped; a visible user prompt opens a turn.
 * Every resumed turn is finished: a resume never re-enters a turn the previous process was running.
 */
export function claudeHistoryOperations(
    transcript: string,
    isTailTruncated: boolean,
): AgentChatPatchOperation[] {
    const state: HistoryState = { ids: new ClaudeBlockIds(), turns: [], items: new Map() };
    for (const line of transcript.split('\n')) {
        const record = parseRecord(line);
        if (record) applyHistoryRecord(state, record);
    }
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

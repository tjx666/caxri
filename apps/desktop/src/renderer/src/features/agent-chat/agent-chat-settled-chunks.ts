import type { AgentChatItem, AgentChatTurn } from '@caxri/protocol';

import { agentChatLastDay } from './agent-chat-time';
import type { AgentChatTimelineEntry } from './agent-chat-timeline';
import { buildAgentChatTimeline } from './agent-chat-timeline';

/**
 * About one turn in this many starts a chunk, so a chunk holds a handful of turns.
 */
const CHUNK_SPREAD = 8;

/**
 * One block of the settled history, rendered and memoized as a unit.
 */
export interface AgentChatSettledChunk {
    /**
     * The chunk's first item id, which stays its first item while history is read back above it or kept below it.
     */
    key: string;
    entries: readonly AgentChatTimelineEntry[];
    /**
     * The day of the chunk's last dated user message, which the next chunk continues.
     */
    lastDay: number | undefined;
}

/**
 * FNV-1a, enough to spread chunk starts evenly over item ids.
 */
function hash(text: string): number {
    let value = 2_166_136_261;
    for (let index = 0; index < text.length; index += 1) {
        value ^= text.codePointAt(index) ?? 0;
        value = Math.imul(value, 16_777_619);
    }
    return value >>> 0;
}

function isChunkStart(item: AgentChatItem, previous: AgentChatItem): boolean {
    return (
        item.type === 'userMessage' &&
        item.turnId !== previous.turnId &&
        hash(item.id) % CHUNK_SPREAD === 0
    );
}

/**
 * Splits the settled history at turn starts chosen by the item's own id, never by its position, so a page read back
 * above or items kept below leave every other chunk exactly as it was, and a turn never spans two chunks.
 */
export function chunkAgentChatHistory(items: readonly AgentChatItem[]): AgentChatItem[][] {
    const chunks: AgentChatItem[][] = [];
    let chunk: AgentChatItem[] = [];
    for (const [index, item] of items.entries()) {
        if (index > 0 && isChunkStart(item, items[index - 1])) {
            chunks.push(chunk);
            chunk = [];
        }
        chunk.push(item);
    }
    if (chunk.length > 0) chunks.push(chunk);
    return chunks;
}

function isSameList<T>(left: readonly T[], right: readonly T[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Chunks built so far, by their first item. Items read back are never replaced, so a chunk whose items and turns are
 * the same objects as last time is returned as the same object, and its memoized block skips rendering.
 */
const built = new WeakMap<
    AgentChatItem,
    {
        items: readonly AgentChatItem[];
        turns: readonly AgentChatTurn[];
        chunk: AgentChatSettledChunk;
    }
>();

/**
 * The settled history as chunks, each built into its own timeline. Reading a page back or keeping an evicted item
 * builds only the chunks it touches, so a Chat that read thousands of entries back still renders a patch in time with
 * the ones in view.
 */
export function agentChatSettledChunks(
    items: readonly AgentChatItem[],
    turns: readonly AgentChatTurn[],
): AgentChatSettledChunk[] {
    const turnOf = new Map(turns.map((turn) => [turn.id, turn]));
    return chunkAgentChatHistory(items).map((chunkItems) => {
        const chunkTurns: AgentChatTurn[] = [];
        for (const item of chunkItems) {
            const turn = item.turnId === undefined ? undefined : turnOf.get(item.turnId);
            if (turn && chunkTurns.at(-1) !== turn) chunkTurns.push(turn);
        }
        const first = chunkItems[0];
        const cached = built.get(first);
        if (cached && isSameList(cached.items, chunkItems) && isSameList(cached.turns, chunkTurns))
            return cached.chunk;
        const entries = buildAgentChatTimeline(chunkItems, chunkTurns, undefined, false);
        const chunk = { key: first.id, entries, lastDay: agentChatLastDay(entries) };
        built.set(first, { items: chunkItems, turns: chunkTurns, chunk });
        return chunk;
    });
}

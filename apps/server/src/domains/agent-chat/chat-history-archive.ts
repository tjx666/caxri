import type { AgentChatItem, AgentChatSnapshot, AgentChatTurn } from '@caxri/protocol';
import {
    agentChatItemTextLength,
    MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS,
    MAX_AGENT_CHAT_HISTORY_PAGE_TEXT_LENGTH,
} from '@caxri/protocol';

/**
 * Bounds of the history one Chat keeps after its items leave the live projection. It is a far larger budget than the
 * projection's own, because only `agentChat.readHistory` pages read it: nothing streams it to Clients. Past it the
 * oldest items are dropped and the archive is marked incomplete.
 */
export const MAX_AGENT_CHAT_ARCHIVE_ITEMS = 20_000;
export const MAX_AGENT_CHAT_ARCHIVE_TEXT_LENGTH = 32 * 1024 * 1024;

/**
 * Items older than a cursor, oldest first, with the turns they belong to.
 */
export interface ChatHistorySlice {
    items: AgentChatItem[];
    turns: AgentChatTurn[];
    /**
     * More items precede `items` in the same source.
     */
    hasMore: boolean;
}

/**
 * The newest items of `items` that fit one history page, always at least one.
 */
export function chatHistoryPageStart(items: readonly AgentChatItem[], end: number): number {
    let start = end;
    let text = 0;
    while (start > 0 && end - start < MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS) {
        text += agentChatItemTextLength(items[start - 1]);
        if (text > MAX_AGENT_CHAT_HISTORY_PAGE_TEXT_LENGTH && start < end) break;
        start -= 1;
    }
    return start;
}

/**
 * The turns `items` belong to, in their order.
 */
export function chatHistoryTurns(
    items: readonly AgentChatItem[],
    turnOf: (turnId: string) => AgentChatTurn | undefined,
): AgentChatTurn[] {
    const turns = new Map<string, AgentChatTurn>();
    for (const item of items) {
        if (item.turnId === undefined || turns.has(item.turnId)) continue;
        const turn = turnOf(item.turnId);
        if (turn) turns.set(item.turnId, turn);
    }
    return turns.values().toArray();
}

/**
 * The history of one Chat older than its live projection. The shared reducer drops the oldest items once the projection
 * outgrows its budget; Server Core keeps them here, in order, so a Client scrolling back can page through the whole
 * conversation while the projection every Client mirrors stays small.
 */
export class ChatHistoryArchive {
    private items: AgentChatItem[] = [];
    private readonly turns = new Map<string, AgentChatTurn>();
    /**
     * How many archived items reference each turn, so a turn is kept exactly while one of its items is.
     */
    private readonly turnReferences = new Map<string, number>();
    private textLength = 0;
    /**
     * Older history exists than the archive holds: the provider did not load it, or the archive dropped it.
     */
    isIncomplete = false;

    private enforceBudget(): void {
        let drop = 0;
        while (
            drop < this.items.length - 1 &&
            (this.items.length - drop > MAX_AGENT_CHAT_ARCHIVE_ITEMS ||
                this.textLength > MAX_AGENT_CHAT_ARCHIVE_TEXT_LENGTH)
        ) {
            const item = this.items[drop];
            this.textLength -= agentChatItemTextLength(item);
            if (item.turnId !== undefined) {
                const count = (this.turnReferences.get(item.turnId) ?? 1) - 1;
                if (count > 0) this.turnReferences.set(item.turnId, count);
                else {
                    this.turnReferences.delete(item.turnId);
                    this.turns.delete(item.turnId);
                }
            }
            drop += 1;
        }
        if (drop === 0) return;
        this.items = this.items.slice(drop);
        this.isIncomplete = true;
    }

    get size(): number {
        return this.items.length;
    }

    clear(): void {
        this.items = [];
        this.turns.clear();
        this.turnReferences.clear();
        this.textLength = 0;
        this.isIncomplete = false;
    }

    hasTurn(turnId: string): boolean {
        return this.turnReferences.has(turnId);
    }

    /**
     * Records what one operation evicted from the projection: `before` is the snapshot it applied to, `after` the
     * result. Eviction only ever drops a prefix of `before.items`.
     */
    recordEviction(before: AgentChatSnapshot, after: AgentChatSnapshot): readonly AgentChatItem[] {
        if (after.items === before.items || before.items.length === 0) return [];
        const first = after.items.at(0);
        if (first?.id === before.items.at(0)?.id) return [];
        const kept = first ? before.items.findIndex((item) => item.id === first.id) : -1;
        const evicted = before.items.slice(0, kept === -1 ? before.items.length : kept);
        if (evicted.length === 0) return [];
        const turnOf = new Map(before.turns.map((turn) => [turn.id, turn]));
        for (const item of evicted) {
            this.items.push(item);
            this.textLength += agentChatItemTextLength(item);
            if (item.turnId === undefined) continue;
            this.turnReferences.set(item.turnId, (this.turnReferences.get(item.turnId) ?? 0) + 1);
            const turn = turnOf.get(item.turnId);
            if (turn) this.turns.set(turn.id, turn);
        }
        this.enforceBudget();
        return evicted;
    }

    /**
     * Keeps the archived turns current when the provider reports its turns again; a turn reported before its items were
     * evicted is recorded by {@link recordEviction}, one reported after it (a resumed history) here.
     */
    recordTurns(turns: readonly AgentChatTurn[]): void {
        for (const turn of turns)
            if (this.turnReferences.has(turn.id)) this.turns.set(turn.id, turn);
    }

    /**
     * The page right before `beforeItemId`. A cursor at the projection's first item (`liveFirstId`) starts from the
     * newest archived item; `undefined` when the archive does not know the cursor.
     */
    page(beforeItemId: string, liveFirstId: string | undefined): ChatHistorySlice | undefined {
        const end =
            beforeItemId === liveFirstId
                ? this.items.length
                : this.items.findIndex((item) => item.id === beforeItemId);
        if (end === -1) return undefined;
        const start = chatHistoryPageStart(this.items, end);
        const items = this.items.slice(start, end);
        return {
            items,
            turns: chatHistoryTurns(items, (turnId) => this.turns.get(turnId)),
            hasMore: start > 0,
        };
    }
}

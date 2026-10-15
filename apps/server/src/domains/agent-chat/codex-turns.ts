import type {
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTurn,
} from '@caxri/protocol';

import { clip, closeDanglingItem, isRecord, MAX_TRACKED_TURNS, stringField } from './chat-items';
import { mapCodexItem } from './codex-items';

/**
 * Pure turn bookkeeping for a Codex Chat: rebuilding the projection from resumed history and closing a finished turn.
 */

type Json = Record<string, unknown>;

function turnStatus(value: unknown): AgentChatTurn['status'] {
    switch (value) {
        case 'completed': {
            return 'completed';
        }
        case 'failed': {
            return 'failed';
        }
        case 'inProgress': {
            return 'running';
        }
        default: {
            return 'interrupted';
        }
    }
}

/**
 * A recorded turn's start in milliseconds. Codex records `startedAt` in Unix seconds; older history has none.
 */
function turnStartMs(turn: Json): number | undefined {
    return typeof turn.startedAt === 'number' &&
        Number.isFinite(turn.startedAt) &&
        turn.startedAt > 0
        ? turn.startedAt * 1000
        : undefined;
}

/**
 * One recorded turn's items, with the dangling ones closed unless the turn is still running. The user message that
 * opened the turn is dated by `startedAt`; a message steered in later, and every other item, stays undated until
 * {@link itemTimeOperations} finds its own time.
 */
export function historyItems(
    rawItems: unknown,
    turnId: string,
    isRunning: boolean,
    startedAt?: number,
): AgentChatItem[] {
    if (!Array.isArray(rawItems)) return [];
    let isOpeningMessage = true;
    return rawItems.flatMap((rawItem) => {
        const mapped = mapCodexItem(rawItem, turnId, false);
        if (!mapped) return [];
        const isOpening = isOpeningMessage && mapped.type === 'userMessage';
        if (mapped.type === 'userMessage') isOpeningMessage = false;
        const item =
            startedAt !== undefined && isOpening ? { ...mapped, createdAt: startedAt } : mapped;
        return [isRunning ? item : (closeDanglingItem(item) ?? item)];
    });
}

/**
 * Operations that date resumed items from `thread/items/list` entries, whose `startedAtMs` is when Codex started each
 * item. Only items still undated are touched, so a live stamp or the turn's own start is never replaced.
 */
export function itemTimeOperations(
    snapshot: AgentChatSnapshot,
    entries: readonly unknown[],
): AgentChatPatchOperation[] {
    const times = new Map<string, number>();
    for (const entry of entries) {
        if (!isRecord(entry) || !isRecord(entry.item)) continue;
        const id = stringField(entry.item.id);
        const time = entry.startedAtMs;
        if (id && typeof time === 'number' && Number.isFinite(time) && time > 0)
            times.set(clip(id, 200), time);
    }
    return snapshot.items.flatMap((item): AgentChatPatchOperation[] => {
        const createdAt = item.createdAt === undefined ? times.get(item.id) : undefined;
        return createdAt === undefined ? [] : [{ op: 'upsertItem', item: { ...item, createdAt } }];
    });
}

/**
 * Operations that replace the projection with a resumed thread's whole history; what the projection's budget evicts
 * stays in Server Core's history archive. A turn still in progress stays open; every other turn's dangling items are
 * closed.
 */
export function historyOperations(
    thread: Json,
    model: string | undefined,
): AgentChatPatchOperation[] {
    const rawTurns = Array.isArray(thread.turns) ? thread.turns : [];
    const turns: AgentChatTurn[] = [];
    const items: AgentChatItem[] = [];
    let activeTurnId: string | undefined;
    for (const rawTurn of rawTurns) {
        if (!isRecord(rawTurn)) continue;
        const turnId = stringField(rawTurn.id);
        if (!turnId) continue;
        const isRunning = rawTurn.status === 'inProgress';
        if (isRunning) activeTurnId = clip(turnId, 200);
        turns.push({
            id: clip(turnId, 200),
            status: isRunning ? 'running' : turnStatus(rawTurn.status),
            ...(typeof rawTurn.durationMs === 'number' &&
                rawTurn.durationMs >= 0 && { durationMs: rawTurn.durationMs }),
        });
        items.push(...historyItems(rawTurn.items, turnId, isRunning, turnStartMs(rawTurn)));
    }
    const operations: AgentChatPatchOperation[] = [{ op: 'reset' }];
    for (const item of items) operations.push({ op: 'upsertItem', item });
    operations.push({
        op: 'state',
        state: {
            turns,
            activeTurnId: activeTurnId ?? null,
            ...(model && { model: clip(model, 200) }),
        },
    });
    return operations;
}

/**
 * Operations that close one finished turn: its dangling items, an error notice for a failed turn, its final status and
 * duration, and the pending requests `shouldKeepRequest` releases. Items in `keepOpen` stay running: a background
 * terminal outlives the turn that started it and completes on its own.
 */
export function finishedTurnOperations(
    snapshot: AgentChatSnapshot,
    turn: Json,
    shouldKeepRequest: (requestId: string, turnId: string) => boolean,
    keepOpen: ReadonlySet<string> = new Set(),
    interruptionReason?: AgentChatTurn['interruptionReason'],
):
    | {
          id: string;
          status: AgentChatTurn['status'];
          durationMs?: number;
          operations: AgentChatPatchOperation[];
      }
    | undefined {
    const turnId = stringField(turn.id);
    if (!turnId) return undefined;
    const id = clip(turnId, 200);
    const status = turnStatus(turn.status);
    const operations: AgentChatPatchOperation[] = [];
    for (const item of snapshot.items) {
        if ((item.turnId !== undefined && item.turnId !== id) || keepOpen.has(item.id)) continue;
        const closed = closeDanglingItem(item);
        if (closed) operations.push({ op: 'upsertItem', item: closed });
    }
    const error = isRecord(turn.error) ? stringField(turn.error.message) : undefined;
    if (status === 'failed' && error)
        operations.push({
            op: 'upsertItem',
            item: {
                id: `${id}:error`,
                turnId: id,
                type: 'notice',
                kind: 'error',
                message: clip(error, 2_000),
            },
        });
    const durationMs =
        typeof turn.durationMs === 'number' && turn.durationMs >= 0 ? turn.durationMs : undefined;
    const existing = snapshot.turns.find((candidate) => candidate.id === id);
    const finished: AgentChatTurn = {
        ...existing,
        id,
        status,
        ...(status === 'interrupted' && interruptionReason && { interruptionReason }),
        ...(durationMs === undefined
            ? existing?.startedAt !== undefined && {
                  durationMs: Math.max(0, Date.now() - existing.startedAt),
              }
            : { durationMs }),
    };
    const turns = existing
        ? snapshot.turns.map((candidate) => (candidate.id === id ? finished : candidate))
        : [...snapshot.turns, finished].slice(-MAX_TRACKED_TURNS);
    const requests = snapshot.requests.filter((request) => shouldKeepRequest(request.id, id));
    operations.push({
        op: 'state',
        state: {
            turns,
            requests,
            ...(snapshot.activeTurnId === id && { activeTurnId: null }),
        },
    });
    return { id, status, durationMs: finished.durationMs, operations };
}

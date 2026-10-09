import type {
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTurn,
} from '@caxri/protocol';

import { clip, closeDanglingItem, isRecord, mapCodexItem } from './codex-items';

/**
 * Pure turn bookkeeping for a Codex Chat: rebuilding the projection from resumed history and closing a finished turn.
 */

type Json = Record<string, unknown>;

/**
 * History loaded on resume is capped by turns; the shared reducer also enforces the item and byte budgets.
 */
const MAX_RESUMED_TURNS = 100;
export const MAX_TRACKED_TURNS = 200;

export function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

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

function historyItems(rawItems: unknown, turnId: string, isRunning: boolean): AgentChatItem[] {
    if (!Array.isArray(rawItems)) return [];
    return rawItems.flatMap((rawItem) => {
        const item = mapCodexItem(rawItem, turnId, false);
        if (!item) return [];
        return [isRunning ? item : (closeDanglingItem(item) ?? item)];
    });
}

/**
 * Operations that replace the projection with a resumed thread's history. A turn still in progress stays open; every
 * other turn's dangling items are closed.
 */
export function historyOperations(
    thread: Json,
    model: string | undefined,
): AgentChatPatchOperation[] {
    const rawTurns = Array.isArray(thread.turns) ? thread.turns : [];
    const turns: AgentChatTurn[] = [];
    const items: AgentChatItem[] = [];
    let activeTurnId: string | undefined;
    const isTruncated = rawTurns.length > MAX_RESUMED_TURNS;
    const resumedTurns = rawTurns.slice(-MAX_RESUMED_TURNS);
    for (const rawTurn of resumedTurns) {
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
        items.push(...historyItems(rawTurn.items, turnId, isRunning));
    }
    const operations: AgentChatPatchOperation[] = [{ op: 'reset' }];
    for (const item of items) operations.push({ op: 'upsertItem', item });
    operations.push({
        op: 'state',
        state: {
            turns,
            /**
             * Only ever raised here: `reset` already cleared it, and the upserts above may have set it while evicting
             * items past the budget, which a plain `false` would hide.
             */
            ...(isTruncated && { truncated: true }),
            activeTurnId: activeTurnId ?? null,
            ...(model && { model: clip(model, 200) }),
        },
    });
    return operations;
}

/**
 * Operations that close one finished turn: its dangling items, an error notice for a failed turn, its final status and
 * duration, and the pending requests `shouldKeepRequest` releases.
 */
export function finishedTurnOperations(
    snapshot: AgentChatSnapshot,
    turn: Json,
    shouldKeepRequest: (requestId: string, turnId: string) => boolean,
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
        if (item.turnId !== undefined && item.turnId !== id) continue;
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

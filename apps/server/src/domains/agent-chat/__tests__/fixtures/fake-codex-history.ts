/**
 * The fake Codex app-server's history as Codex sends it: the thread a start or resume returns, and the paged reads
 * `thread/turns/list` and `thread/items/list`.
 */
import process from 'node:process';

import type { FakeThread, FakeTurn } from './fake-codex-io.ts';
import { DEFAULT_MODEL_ID } from './fake-codex-models.ts';

type Json = Record<string, unknown>;

function pageLimit(parameters: Json): number {
    return typeof parameters.limit === 'number' ? parameters.limit : 25;
}

/**
 * The turn fields Codex sends; the fake's own bookkeeping flags stay private.
 */
export function wireTurn(turn: FakeTurn): Json {
    return {
        id: turn.id,
        items: turn.items,
        status: turn.status,
        error: turn.error,
        // Codex records turn times in Unix seconds.
        startedAt: Math.floor(turn.startedAt / 1000),
        durationMs: turn.durationMs,
    };
}

/**
 * The thread, model, effort, and service tier `thread/start` and `thread/resume` answer with.
 */
export function threadResponse(thread: FakeThread, { excludeTurns = false } = {}): Json {
    return {
        thread: {
            id: thread.id,
            status: { type: 'idle' },
            cwd: process.cwd(),
            historyMode: 'paginated',
            turns: excludeTurns ? [] : thread.turns.map((turn) => wireTurn(turn)),
        },
        model: thread.model ?? DEFAULT_MODEL_ID,
        reasoningEffort: thread.effort ?? null,
        serviceTier: thread.serviceTier ?? null,
        collaborationMode: thread.collaborationMode
            ? {
                  mode: thread.collaborationMode,
                  settings: {
                      model: thread.model ?? DEFAULT_MODEL_ID,
                      reasoning_effort: thread.effort ?? null,
                      developer_instructions: null,
                  },
              }
            : null,
    };
}

/**
 * A page of turns with their items, as `thread/turns/list` returns them: newest first unless `sortDirection` is `asc`.
 * The cursor is the offset of the next page.
 */
export function listThreadTurns(thread: FakeThread, parameters: Json): Json {
    const ordered = parameters.sortDirection === 'asc' ? thread.turns : thread.turns.toReversed();
    const start = typeof parameters.cursor === 'string' ? Number(parameters.cursor) : 0;
    const end = start + pageLimit(parameters);
    return {
        data: ordered.slice(start, end).map((turn) => wireTurn(turn)),
        nextCursor: end < ordered.length ? String(end) : null,
        backwardsCursor: null,
    };
}

/**
 * What Codex pushes when a client asks for a paginated thread's full history.
 */
export const FULL_HISTORY_DEPRECATION = {
    summary:
        'Full-history hydration is deprecated for paginated threads; use `excludeTurns: true`, then page with `thread/turns/list` and `thread/items/list`.',
    details: null,
};

/**
 * The newest items first, each with when it started, as `thread/items/list` returns them.
 */
export function listThreadItems(thread: FakeThread, parameters: Json): Json {
    const entries = thread.turns
        .flatMap((turn) =>
            turn.items.map((item) => ({
                turnId: turn.id,
                item,
                startedAtMs: turn.itemTimes?.[item.id] ?? null,
                completedAtMs: null,
            })),
        )
        .toReversed()
        .slice(0, pageLimit(parameters));
    return { data: entries, nextCursor: null, backwardsCursor: null };
}

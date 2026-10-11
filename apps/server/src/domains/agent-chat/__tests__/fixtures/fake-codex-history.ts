/**
 * The fake Codex app-server's paged history reads: `thread/turns/list` and `thread/items/list`.
 */
import type { FakeThread, FakeTurn } from './fake-codex-io.ts';

type Json = Record<string, unknown>;

function pageLimit(parameters: Json): number {
    return typeof parameters.limit === 'number' ? parameters.limit : 25;
}

/**
 * The newest turns first, with their items, as `thread/turns/list` returns them.
 */
export function listThreadTurns(
    thread: FakeThread,
    parameters: Json,
    wireTurn: (turn: FakeTurn) => Json,
): Json {
    const turns = thread.turns.toReversed().slice(0, pageLimit(parameters));
    return { data: turns.map((turn) => wireTurn(turn)), nextCursor: null, backwardsCursor: null };
}

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

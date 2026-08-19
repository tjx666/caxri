import type { LogQueryRecord, LogQueryResult } from '@shared/types';

/**
 * Records accumulated across cursor-follow `logs.query` pages, oldest first. `cursor` is the resume point for the next
 * poll and survives {@link clearLogStream} so Clear empties the view without replaying history. `gap` latches once the
 * server reports records were dropped between polls.
 */
export interface LogStreamState {
    records: LogQueryRecord[];
    cursor?: string;
    gap: boolean;
}

export const MAX_STREAM_RECORDS = 2_000;

export const emptyLogStream: LogStreamState = { records: [], gap: false };

/**
 * Folds one server page into the stream. Records are deduplicated by content id so a repeated fetch of the same page
 * (e.g. a poll returning no new rows) is a no-op, and the buffer is capped from the front at {@link MAX_STREAM_RECORDS}.
 * Returns the input state unchanged when the page adds nothing, so React effects can fold every poll without
 * re-rendering idle panels.
 */
export function appendLogPage(
    state: LogStreamState,
    page: LogQueryResult,
    cap: number = MAX_STREAM_RECORDS,
): LogStreamState {
    const known = new Set(state.records.map((record) => record.id));
    const fresh = page.records.filter((record) => !known.has(record.id));
    const cursor = page.nextCursor ?? state.cursor;
    const gap = state.gap || page.gap;
    if (fresh.length === 0 && cursor === state.cursor && gap === state.gap) return state;
    const records = [...state.records, ...fresh];
    return {
        records: records.length > cap ? records.slice(records.length - cap) : records,
        ...(cursor && { cursor }),
        gap,
    };
}

export function clearLogStream(state: LogStreamState): LogStreamState {
    return { records: [], ...(state.cursor && { cursor: state.cursor }), gap: false };
}

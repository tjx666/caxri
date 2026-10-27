import type { LogQueryRecord, LogQueryResult } from '@caxri/protocol';

/**
 * Records accumulated across cursor-follow `logs.query` pages, oldest first. `cursor` is the resume point for the next
 * poll and survives {@link clearLogStream} so Clear empties the view without replaying history. `gap` latches once the
 * server reports records were dropped between polls.
 *
 * `gapEpoch` is a monotonically increasing generation counter for the gap banner (see `log-viewer-panel.tsx`'s dismiss
 * button). `gap` alone can't tell a dismissed drop from a brand-new one: it only ever flips `false -> true` and then
 * latches, so a dismiss action has nothing to compare against. `gapEpoch` instead increments on every event that should
 * be treated as a _new_ generation worth re-surfacing the banner for: a fresh page that actually advances the cursor
 * while reporting a gap (the only "newly detected gap" signal the `logs.query` payload exposes), and `clearLogStream`/a
 * process-filter switch, both of which start a new viewing session the user hasn't acknowledged yet. The panel
 * remembers the epoch it was dismissed at and re-shows the banner once the live epoch moves past it.
 */
export interface LogStreamState {
    records: LogQueryRecord[];
    cursor?: string;
    gap: boolean;
    gapEpoch: number;
}

const MAX_STREAM_RECORDS = 2_000;

export const emptyLogStream: LogStreamState = { records: [], gap: false, gapEpoch: 0 };

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
    const fresh = page.records.filter((record) => {
        if (known.has(record.id)) return false;
        known.add(record.id);
        return true;
    });
    const cursor = page.nextCursor ?? state.cursor;
    const gap = state.gap || page.gap;
    // Only a page that actually moves the cursor counts as a new poll result; a page.gap on a
    // repeated (already-seen) cursor is not a fresh drop, so it must not keep bumping the epoch on
    // every idle poll.
    const isNewCursor = cursor !== state.cursor;
    const gapEpoch = isNewCursor && page.gap ? state.gapEpoch + 1 : state.gapEpoch;
    if (
        fresh.length === 0 &&
        cursor === state.cursor &&
        gap === state.gap &&
        gapEpoch === state.gapEpoch
    )
        return state;
    const records = [...state.records, ...fresh];
    return {
        records: records.length > cap ? records.slice(records.length - cap) : records,
        ...(cursor && { cursor }),
        gap,
        gapEpoch,
    };
}

export function clearLogStream(state: LogStreamState): LogStreamState {
    return {
        records: [],
        ...(state.cursor && { cursor: state.cursor }),
        gap: false,
        // Bumped (not reset to 0) so a dismissal recorded against the pre-clear epoch never
        // coincidentally matches a later epoch and hides a genuinely new gap.
        gapEpoch: state.gapEpoch + 1,
    };
}

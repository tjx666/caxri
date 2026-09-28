import { useMemo } from 'react';

import type { SessionRecord } from '@caxri/protocol';

import { sessionIdsKey } from '../session-order';

/**
 * The ids of the rows a Session list shows, as one array that keeps its identity until the membership or order changes.
 * Every row in the list receives it for `Alt+Arrow` reordering, so an array rebuilt from the records would render every
 * row again on each Session switch, which replaces records without moving any row (issue #1356).
 */
export function useVisibleSessionIds(sessions: readonly SessionRecord[]): readonly string[] {
    const key = sessionIdsKey(sessions);
    return useMemo(() => JSON.parse(key) as readonly string[], [key]);
}

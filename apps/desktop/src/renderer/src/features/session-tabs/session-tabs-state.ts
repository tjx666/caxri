import { SESSION_TAB_STRIP_MIN_SESSIONS } from '../../stores/open-sessions';

/**
 * Drag payload type of a strip tab. Distinct from a pane tab's and a sidebar row's, so a Session tab dropped on a pane
 * or a sidebar row is ignored instead of misread.
 */
export const SESSION_TAB_DRAG_TYPE = 'application/x-caxri-session-tab';

export function isSessionTabStripVisible(openSessionIds: readonly string[]): boolean {
    return openSessionIds.length >= SESSION_TAB_STRIP_MIN_SESSIONS;
}

/**
 * Adds a Session at the end of the strip. An entry that is already open keeps its place, the way a browser focuses an
 * existing tab instead of duplicating it.
 */
export function appendOpenSession(ids: readonly string[], sessionId: string): string[] {
    return ids.includes(sessionId) ? [...ids] : [...ids, sessionId];
}

/**
 * Moves one entry so it lands before the entry currently at `targetIndex` of the strip without it, or at the end when
 * `targetIndex` is `undefined`. That is the index `resolveTabDropIndex` reports for a drop point once the dragged tab's
 * own rectangle is excluded from the measurement.
 */
export function moveOpenSession(
    ids: readonly string[],
    sessionId: string,
    targetIndex: number | undefined,
): string[] {
    if (!ids.includes(sessionId)) return [...ids];
    const rest = ids.filter((id) => id !== sessionId);
    const index = targetIndex === undefined ? rest.length : Math.min(targetIndex, rest.length);
    return [...rest.slice(0, index), sessionId, ...rest.slice(index)];
}

/**
 * Moves an entry one step, for the keyboard. Stays put at either end.
 */
export function shiftOpenSession(
    ids: readonly string[],
    sessionId: string,
    direction: -1 | 1,
): string[] {
    const index = ids.indexOf(sessionId);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= ids.length) return [...ids];
    return moveOpenSession(ids, sessionId, target);
}

/**
 * The entries a close action removes. A strip never closes down to nothing: the entry that stays is the one the action
 * was aimed at, or the first when that was not in the strip.
 */
export type SessionTabCloseScope = 'one' | 'others' | 'right';

export function sessionIdsToClose(
    ids: readonly string[],
    sessionId: string,
    scope: SessionTabCloseScope,
): string[] {
    const index = ids.indexOf(sessionId);
    if (index === -1) return [];
    if (scope === 'one') return ids.length > 1 ? [sessionId] : [];
    if (scope === 'others') return ids.filter((id) => id !== sessionId);
    return ids.slice(index + 1);
}

export function withoutOpenSessions(ids: readonly string[], removed: readonly string[]): string[] {
    const closing = new Set(removed);
    return ids.filter((id) => !closing.has(id));
}

/**
 * Which entry is active once `nextIds` replaces `previousIds`. The active entry stays while it is still open; closing
 * it moves to its neighbor, the next entry first and then the one before. The Server applies the same rule when it
 * stores a strip (`replaceWindowOpenSessions`), so the optimistic result here and the Server's answer agree.
 */
export function activeAfterEdit(
    previousIds: readonly string[],
    activeId: string | undefined,
    nextIds: readonly string[],
): string | undefined {
    if (activeId !== undefined && nextIds.includes(activeId)) return activeId;
    if (activeId !== undefined) {
        const index = previousIds.indexOf(activeId);
        if (index !== -1) {
            const neighbors = [
                ...previousIds.slice(index + 1),
                ...previousIds.slice(0, index).toReversed(),
            ];
            const neighbor = neighbors.find((id) => nextIds.includes(id));
            if (neighbor !== undefined) return neighbor;
        }
    }
    return nextIds[0];
}

/**
 * The entry `Cmd+<position>` switches to. Positions 1 to 8 are literal, and 9 always means the last entry, the browser
 * convention, so `Cmd+9` stays useful with 20 tabs open. A position past the end selects nothing instead of wrapping.
 */
export function openTabTargetId(ids: readonly string[], position: number): string | undefined {
    if (!Number.isSafeInteger(position) || position < 1 || position > 9) return undefined;
    return position === 9 ? ids.at(-1) : ids[position - 1];
}

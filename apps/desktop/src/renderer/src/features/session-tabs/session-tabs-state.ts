import { SESSION_TAB_STRIP_MIN_SESSIONS } from '../../stores/open-sessions';

/**
 * Drag payload type of a strip tab. Distinct from a pane tab's and a sidebar row's, so a Session tab dropped on a pane
 * or a sidebar row is ignored instead of misread.
 */
export const SESSION_TAB_DRAG_TYPE = 'application/x-caxri-session-tab';

/**
 * Whether ending a strip-tab drag tears the tab off into a new window: the drag ended outside every drop target
 * (`dropEffect` is `none`; a tab dropped back on its own strip reports `move`), and the window keeps another tab. The
 * strip is hidden below two Open Sessions, so a lone tab cannot start the drag, but the guard keeps a stale drag from
 * moving a window's last Session.
 */
export function shouldTearOffSessionTab(input: {
    dropEffect: string;
    /**
     * Whether the strip handled a drop for this drag; a handled drop never tears off, whatever `dropEffect` reports.
     */
    dropped: boolean;
    tabCount: number;
}): boolean {
    return !input.dropped && input.dropEffect === 'none' && input.tabCount >= 2;
}

export function isSessionTabStripVisible(openSessionIds: readonly string[]): boolean {
    return openSessionIds.length >= SESSION_TAB_STRIP_MIN_SESSIONS;
}

/**
 * Adds a Session immediately right of `anchorId` (the active entry), the way a browser opens a link in a new tab, so a
 * new tab lands next to where the user was working instead of at the far end of a long strip. Appends when there is no
 * anchor or the anchor is not in the strip. An entry that is already open keeps its place, the way a browser focuses an
 * existing tab instead of duplicating it. The Server applies the same rule to the strip's `+`
 * (`activateSessionInWindow`), so the optimistic result here and the Server's answer agree.
 */
export function insertOpenSessionAfter(
    ids: readonly string[],
    sessionId: string,
    anchorId: string | undefined,
): string[] {
    if (ids.includes(sessionId)) return [...ids];
    const anchorIndex = anchorId === undefined ? -1 : ids.indexOf(anchorId);
    return ids.toSpliced(anchorIndex === -1 ? ids.length : anchorIndex + 1, 0, sessionId);
}

/**
 * The Preview entry after a strip edit: it stays while it is still listed, and an edit never creates one (a Session the
 * edit adds is kept). The Server applies the same rule when it stores a strip (`replaceWindowOpenSessions`).
 */
export function previewAfterEdit(
    previewId: string | undefined,
    nextIds: readonly string[],
): string | undefined {
    return previewId !== undefined && nextIds.includes(previewId) ? previewId : undefined;
}

/**
 * Whether a DOM event inside the Session counts as the user working in it, which keeps a Preview entry. A bare modifier
 * and a chord (Cmd/Ctrl + key, the app's own shortcuts such as `Cmd+1`) do not: switching tabs by keyboard must not
 * keep the tab it lands on. A pointer press counts only for the primary button.
 */
export function isKeepingInteraction(event: {
    type: string;
    button?: number;
    key?: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
}): boolean {
    switch (event.type) {
        case 'keydown':
            return (
                !event.metaKey &&
                !event.ctrlKey &&
                !['Alt', 'Control', 'Meta', 'Shift'].includes(event.key ?? '')
            );
        case 'pointerdown':
            return (event.button ?? 0) === 0;
        case 'paste':
        case 'input':
            return true;
        default:
            return false;
    }
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
            const nextSet = new Set(nextIds);
            const neighbor = neighbors.find((id) => nextSet.has(id));
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

/**
 * The `aria-keyshortcuts` value for the tab at `index` of `count`: `Meta+<position>` for the first eight, and `Meta+9`
 * on the last tab, which is what `Cmd+9` selects (see {@link openTabTargetId}). A ninth or later tab that is not the
 * last one has no chord. With nine tabs the ninth is both, and `Meta+9` is right.
 */
export function sessionTabShortcutKey(index: number, count: number): string | undefined {
    if (index < 8) return `Meta+${index + 1}`;
    return index === count - 1 ? 'Meta+9' : undefined;
}

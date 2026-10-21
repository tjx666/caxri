import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { applyWindowOpenSessions, getOpenSessionIds } from '../../stores/open-sessions';
import { getBootstrap } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { didSelectSession } from '../session/session-commands';
import type { SessionTabCloseScope } from './session-tabs-state';
import {
    activeAfterEdit,
    canMoveSessionToNewWindow,
    insertOpenSessionAfter,
    moveOpenSession,
    openTabTargetId,
    previewAfterEdit,
    sessionIdsToClose,
    shiftOpenSession,
    withoutOpenSessions,
} from './session-tabs-state';

/**
 * Strip edits run one at a time. Each computes its result from the strip as the previous edit left it, so a quick
 * second close or a drop right after a reorder builds on the first instead of overwriting it with a stale list.
 */
const editQueue = { tail: Promise.resolve() as Promise<unknown> };

/**
 * Replaces this window's strip. `compute` receives the strip and active Session as they are when the edit runs and
 * returns the new order, or `undefined` for no change.
 *
 * The strip is applied optimistically so a reorder or close lands under the pointer, then replaced with the Server's
 * stored answer (which also drops entries it found archived or deleted). The Server never receives the active Session:
 * it changes only through `session.select`, so a delayed save here cannot undo a newer selection. A failure toasts and
 * re-reads the snapshot, which discards the optimistic edit.
 */
function editOpenSessions(
    failure: string,
    compute: (ids: readonly string[], activeId: string | undefined) => string[] | undefined,
): Promise<boolean> {
    const wasEditApplied = async (): Promise<boolean> => {
        const ids = getOpenSessionIds();
        const activeId = getBootstrap()?.selectedSessionId;
        const next = compute(ids, activeId);
        if (!next || (next.length === ids.length && next.every((id, index) => id === ids[index])))
            return false;
        applyWindowOpenSessions({
            openSessionIds: next,
            activeSessionId: activeAfterEdit(ids, activeId, next) ?? null,
            previewSessionId: previewAfterEdit(getBootstrap()?.previewSessionId, next) ?? null,
        });
        const stored = await tryCommand(failure, () =>
            caxri.request('window.openSessions.set', { openSessionIds: next }),
        );
        if (!stored) {
            await refreshWorkbench();
            return false;
        }
        applyWindowOpenSessions(stored);
        return true;
    };
    const result = (async () => {
        await editQueue.tail;
        return wasEditApplied();
    })();
    editQueue.tail = (async () => {
        try {
            await result;
        } catch {
            // A failed edit must not block the edits queued behind it; its caller sees the rejection.
        }
    })();
    return result;
}

/**
 * Switching to an Open Session is an ordinary Session selection, so it records history, restores the Session's
 * Terminals, and converges through the same `state.changed` path as a sidebar click.
 */
export function activateSessionTab(sessionId: string): void {
    if (getBootstrap()?.selectedSessionId === sessionId) return;
    // Fire-and-forget: didSelectSession reports its own failures through a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard
    void didSelectSession(sessionId);
}

/**
 * Promotes the Preview entry to a kept entry: a double-click, "Keep Open", Cmd+click, a reorder, or working in the
 * Session. Does nothing for any other Session, so callers need not check first. Applied optimistically (the tab leaves
 * its italic style under the pointer) and then replaced with the Server's answer.
 */
export async function keepSessionTab(sessionId: string): Promise<void> {
    const bootstrap = getBootstrap();
    if (bootstrap?.previewSessionId !== sessionId) return;
    applyWindowOpenSessions({
        openSessionIds: getOpenSessionIds().slice(),
        activeSessionId: bootstrap.selectedSessionId ?? null,
        previewSessionId: null,
    });
    const stored = await tryCommand(translate('sessionTabs.errors.keepFailed'), () =>
        caxri.request('window.openSessions.keep', { sessionId }),
    );
    if (stored) applyWindowOpenSessions(stored);
    else await refreshWorkbench();
}

/**
 * Keeps the active Session's tab when it is the Preview entry. Called for every interaction inside the Session (see
 * `usePromotePreviewOnInteraction`), so it must stay a cheap synchronous check when there is nothing to keep.
 */
export function keepActiveSessionTab(): void {
    const bootstrap = getBootstrap();
    const activeId = bootstrap?.selectedSessionId;
    // Fire-and-forget: keeping toasts its own failure.
    // eslint-disable-next-line no-void -- intentional floating-promise discard
    if (activeId && bootstrap.previewSessionId === activeId) void keepSessionTab(activeId);
}

/**
 * Cmd+click and "Open in New Tab": adds the Session to the strip right of the active tab as a kept entry, then shows
 * it. A Session that is already open is activated (and kept, when it was the Preview entry), and one that another
 * window owns brings that window forward.
 */
export async function openSessionInNewTab(sessionId: string): Promise<void> {
    if (getOpenSessionIds().includes(sessionId)) await keepSessionTab(sessionId);
    else {
        const wasStored = await editOpenSessions(
            translate('sessionTabs.errors.openFailed'),
            (ids, activeId) => insertOpenSessionAfter(ids, sessionId, activeId),
        );
        // A failed append already told the user why. A stored strip that still lacks the Session means another window
        // owns it, and selecting it brings that window forward.
        if (!wasStored) return;
    }
    activateSessionTab(sessionId);
}

/**
 * Closing a tab only removes it from the strip; the Session stays in the sidebar and keeps running. Closing the active
 * tab moves to its neighbor. The last Open Session cannot be closed.
 */
export async function closeSessionTabs(
    sessionId: string,
    scope: SessionTabCloseScope = 'one',
): Promise<void> {
    await editOpenSessions(translate('sessionTabs.errors.closeFailed'), (ids) => {
        const closing = sessionIdsToClose(ids, sessionId, scope);
        return closing.length > 0 ? withoutOpenSessions(ids, closing) : undefined;
    });
}

export function closeActiveSessionTab(): void {
    const activeId = getBootstrap()?.selectedSessionId;
    // Fire-and-forget: the edit toasts its own failure.
    // eslint-disable-next-line no-void -- intentional floating-promise discard
    if (activeId) void closeSessionTabs(activeId);
}

/**
 * Drops a dragged tab at `targetIndex` (see `moveOpenSession`).
 */
export async function reorderSessionTab(
    sessionId: string,
    targetIndex: number | undefined,
): Promise<void> {
    // Dragging a tab is deliberate, so it also keeps a Preview tab (VS Code does the same).
    await keepSessionTab(sessionId);
    await editOpenSessions(translate('sessionTabs.errors.reorderFailed'), (ids) =>
        moveOpenSession(ids, sessionId, targetIndex),
    );
}

/**
 * Drag-out: asks Main to open a new window for a tab released outside every window. Main owns the placement and the
 * Server move, and refuses a release over a Workbench window, so a refused tear-off simply leaves the strip as it was.
 * This window's strip then converges through the `window.openSessions` state change, but the snapshot is re-read
 * explicitly so the tab leaves the strip even when that event is replayed late.
 *
 * `screenPoint` is where the drag ended, in screen coordinates; it is omitted when the platform reported none, and Main
 * falls back to the cursor.
 */
export async function tearOffSessionTab(
    sessionId: string,
    screenPoint?: { x: number; y: number },
): Promise<void> {
    const result = await tryCommand(translate('sessionTabs.errors.tearOffFailed'), () =>
        caxri.request('window.tearOffSession', { sessionId, ...(screenPoint && { screenPoint }) }),
    );
    if (result?.opened) await refreshWorkbench();
}

/**
 * "Move to New Window": the non-drag way to tear a tab off (tab menu, sidebar row menu, Command Palette), for users who
 * cannot or would rather not drag. Main cascades the new window from this one instead of using a release point.
 */
export async function moveSessionToNewWindow(sessionId: string): Promise<void> {
    if (!canMoveSessionToNewWindow(getOpenSessionIds(), sessionId)) return;
    const result = await tryCommand(translate('sessionTabs.errors.tearOffFailed'), () =>
        caxri.request('window.tearOffSession', { sessionId, placement: 'cascade' }),
    );
    if (result?.opened) await refreshWorkbench();
}

export function moveActiveSessionToNewWindow(): void {
    const activeId = getBootstrap()?.selectedSessionId;
    // Fire-and-forget: the move toasts its own failure.
    // eslint-disable-next-line no-void -- intentional floating-promise discard
    if (activeId) void moveSessionToNewWindow(activeId);
}

export async function shiftSessionTab(sessionId: string, direction: -1 | 1): Promise<void> {
    await editOpenSessions(translate('sessionTabs.errors.reorderFailed'), (ids) =>
        shiftOpenSession(ids, sessionId, direction),
    );
}

/**
 * `Cmd+1` to `Cmd+9`: shows the Open Session at that position, `9` meaning the last. A position past the end is a
 * no-op.
 */
export function openSessionTabAtPosition(position: number): void {
    const target = openTabTargetId(getOpenSessionIds(), position);
    if (target) activateSessionTab(target);
}

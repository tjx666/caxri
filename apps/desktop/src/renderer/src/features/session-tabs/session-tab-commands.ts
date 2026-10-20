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
    appendOpenSession,
    moveOpenSession,
    openTabTargetId,
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
 * Cmd+click and "Open in New Tab": adds the Session to the strip without leaving the current one's place, then shows
 * it. A Session that is already open is only activated.
 */
export async function openSessionInNewTab(sessionId: string): Promise<void> {
    if (!getOpenSessionIds().includes(sessionId)) {
        await editOpenSessions(translate('sessionTabs.errors.openFailed'), (ids) =>
            appendOpenSession(ids, sessionId),
        );
        // Nothing to show if the append failed; the edit already told the user why.
        if (!getOpenSessionIds().includes(sessionId)) return;
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
    await editOpenSessions(translate('sessionTabs.errors.reorderFailed'), (ids) =>
        moveOpenSession(ids, sessionId, targetIndex),
    );
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

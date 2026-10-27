import type { SessionRestorePlacement } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { useDialogStore } from '../../stores/dialogs';
import { getSelectedSession } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { recordClosedSession } from '../closed-items/recording';
import {
    describeArchivedSession,
    describeRestoredSession,
    describeRestoredSessions,
} from './session-notice-copy';
import { sessionTitleForDisplay } from './session-title';

/**
 * Archiving deliberately skips a confirmation because it is reversible, but the Archived Sessions dialog it relies on
 * is reachable only through the PrimarySidebar footer entry, which `Command+[` hides entirely, and the `Delete`
 * keyboard path reports nothing at all on its own. The notice is therefore the state-change record for both the hover
 * button and the keyboard shortcut, it carries the reversal inline so the escape hatch never depends on finding that
 * dialog, and Sonner's live region gives the keyboard path its screen-reader announcement. It stays an ordinary
 * four-second toast: `persist` is reserved for events that already cost the user something irreversible.
 */
async function archiveSessionWithNotice(sessionId: string): Promise<void> {
    const archived = await tryCommand(
        translate('session.errors.archiveFailed'),
        () => caxri.request('session.archive', { sessionId }),
        { refresh: refreshWorkbench },
    );
    if (!archived) return;
    recordClosedSession(sessionId);
    pushToast('info', describeArchivedSession(archived.title), {
        /**
         * The notice outlives the row it describes, and now outlives the toast as well: the offer is still in the
         * notification center after the Session has been deleted or the window navigated elsewhere. `unarchiveSession`
         * runs the request through `tryCommand`, so a stale Undo reports one error toast instead of throwing out of the
         * click handler. The handler restores with `unchanged`, so the row returns to the position it was archived
         * from, not to the top of the Project the way an explicit restore does. One thing Undo deliberately does not
         * put back is the pin: archiving clears it, and restoring it here would resurrect a Pinned row the user may
         * have stopped watching weeks ago. They pin it again if they still want it there.
         */
        action: {
            id: 'session.unarchive',
            params: { sessionId },
            // Several archived Sessions leave several `Undo` buttons in the history, identical to a screen reader
            // reading the buttons alone. The title says which one this is.
            accessibleLabel: translate('session.notice.undoArchive', {
                title: sessionTitleForDisplay(archived.title, translate),
            }),
        },
    });
}

export function archiveSession(sessionId: string): void {
    // Fire-and-forget: `archiveSessionWithNotice` funnels its own failures into a toast via `tryCommand`.
    void archiveSessionWithNotice(sessionId);
}

export function archiveSelectedSession(): void {
    const session = getSelectedSession();
    if (session) archiveSession(session.id);
}

/**
 * Opens the Archived Sessions manager. Its only other entry point is the Primary Side Bar footer button, which
 * `Command+[` hides along with the rest of the side bar.
 */
export function openArchivedSessions(): void {
    useDialogStore.getState().setArchivedSessionsOpen(true);
}

async function didRestoreSessionWithNotice(
    sessionId: string,
    placement: SessionRestorePlacement,
): Promise<boolean> {
    const restored = await tryCommand(
        translate('session.errors.restoreFailed'),
        () => caxri.request('session.unarchive', { placement, sessionId }),
        { refresh: refreshWorkbench },
    );
    /**
     * `unchanged` is the archive notice's Undo, and only that. It already named the Session it was reversing one toast
     * ago, and it restores the row into a PrimarySidebar the user can see, so a second notice would report a change
     * they just watched happen. An explicit restore has neither: it is issued from a dialog wide enough to cover the
     * sidebar, so without this the row reappears somewhere the user cannot see and nothing says so.
     */
    if (!restored) return false;
    if (placement !== 'unchanged') pushToast('info', describeRestoredSession(restored.title));
    return true;
}

/**
 * Restores an archived Session back to the row it was archived from, resolving to whether the Server restored it.
 * Reopen Closed Editor or Session uses it: like the archive notice's Undo, it reverses one archive and so reports no
 * second notice.
 */
export function restoreArchivedSession(sessionId: string): Promise<boolean> {
    return didRestoreSessionWithNotice(sessionId, 'unchanged');
}

/**
 * Restoring puts the Session back on top of its Project by default, so the row the user just asked for is the one they
 * see. Only the archive notice's Undo passes `unchanged`: it reverses a single archive, and a row that jumped to the
 * top would have rewritten the order the user arranged by dragging.
 */
export function unarchiveSession(
    sessionId: string,
    placement: SessionRestorePlacement = 'top',
): void {
    // Fire-and-forget: `didRestoreSessionWithNotice` funnels its own failures into a toast via `tryCommand`.
    void didRestoreSessionWithNotice(sessionId, placement);
}

/**
 * Bulk restore from the Archived Sessions manager: one request, one bootstrap refresh, regardless of batch size. The
 * batch lands on top of its Projects in the order given, so the dialog's first row stays the first row afterwards.
 */
async function unarchiveSessionsWithNotice(sessionIds: readonly string[]): Promise<void> {
    const restored = await tryCommand(
        translate('session.errors.restoreFailed'),
        () =>
            caxri.request('session.unarchiveMany', {
                placement: 'top',
                sessionIds: [...sessionIds],
            }),
        { refresh: refreshWorkbench },
    );
    // Reports what the Server actually restored rather than what was requested: a stale selection can name a Session
    // that was deleted between opening the dialog and pressing Restore.
    if (!restored || restored.length === 0) return;
    pushToast('info', describeRestoredSessions(restored.map((session) => session.title)));
}

export function unarchiveSessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    // Fire-and-forget: `unarchiveSessionsWithNotice` funnels its own failures into a toast via `tryCommand`.
    void unarchiveSessionsWithNotice(sessionIds);
}

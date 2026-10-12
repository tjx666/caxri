import type { SessionRestorePlacement } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';
import { useDialogStore } from '../../stores/dialogs';
import { getSelectedSession } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';

/**
 * Longest Session title a lifecycle notice quotes. Titles are user- and Agent-authored and effectively unbounded, so a
 * runaway one would push the notice's own verb and its action button out of the toast's fixed width.
 */
const SESSION_NOTICE_TITLE_MAX_LENGTH = 48;

/**
 * Copy for a notice that records one Session lifecycle change. An empty `displayTitle` is representable in the Session
 * record (a Shell-only Session has no Agent to name it) and quoting nothing reads as a rendering bug, so that case
 * names the noun instead of the title.
 */
function describeSessionNotice(verb: string, displayTitle: string | undefined): string {
    const title = displayTitle?.trim() ?? '';
    if (title.length === 0) return `${verb} Session`;
    // Count and cut by code point: an Agent-authored title can end on an emoji, and a UTF-16 cut would leave a lone
    // surrogate that renders as the replacement character.
    const characters = [...title];
    if (characters.length <= SESSION_NOTICE_TITLE_MAX_LENGTH) return `${verb} "${title}"`;
    const head = characters.slice(0, SESSION_NOTICE_TITLE_MAX_LENGTH).join('').trimEnd();
    return `${verb} "${head}…"`;
}

export function describeArchivedSession(displayTitle: string | undefined): string {
    return describeSessionNotice('Archived', displayTitle);
}

/**
 * Restore's counterpart to {@link describeArchivedSession}. Archive and restore are one reversible pair, so they report
 * themselves in one shape; a restore that announced nothing was the only Session state change with no record at all,
 * and it happens inside a dialog large enough to cover the PrimarySidebar row it just brought back.
 */
export function describeRestoredSession(displayTitle: string | undefined): string {
    return describeSessionNotice('Restored', displayTitle);
}

/**
 * Copy for a batch restore. Quoting a batch is not possible in a toast's width, so the count carries the record; a
 * single-Session batch still names its Session, because there the title is the useful part.
 */
export function describeRestoredSessions(displayTitles: ReadonlyArray<string | undefined>): string {
    if (displayTitles.length === 1) return describeRestoredSession(displayTitles[0]);
    return `Restored ${displayTitles.length} Sessions`;
}

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
        'Session archive failed',
        () => caxri.request('session.archive', { sessionId }),
        { refresh: refreshWorkbench },
    );
    if (!archived) return;
    pushToast('info', describeArchivedSession(archived.displayTitle), {
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
            accessibleLabel: `Undo archiving ${archived.displayTitle}`,
        },
    });
}

export function archiveSession(sessionId: string): void {
    // Fire-and-forget: `archiveSessionWithNotice` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
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

async function unarchiveSessionWithNotice(
    sessionId: string,
    placement: SessionRestorePlacement,
): Promise<void> {
    const restored = await tryCommand(
        'Session restore failed',
        () => caxri.request('session.unarchive', { placement, sessionId }),
        { refresh: refreshWorkbench },
    );
    /**
     * `unchanged` is the archive notice's Undo, and only that. It already named the Session it was reversing one toast
     * ago, and it restores the row into a PrimarySidebar the user can see, so a second notice would report a change
     * they just watched happen. An explicit restore has neither: it is issued from a dialog wide enough to cover the
     * sidebar, so without this the row reappears somewhere the user cannot see and nothing says so.
     */
    if (!restored || placement === 'unchanged') return;
    pushToast('info', describeRestoredSession(restored.displayTitle));
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
    // Fire-and-forget: `unarchiveSessionWithNotice` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void unarchiveSessionWithNotice(sessionId, placement);
}

/**
 * Bulk restore from the Archived Sessions manager: one request, one bootstrap refresh, regardless of batch size. The
 * batch lands on top of its Projects in the order given, so the dialog's first row stays the first row afterwards.
 */
async function unarchiveSessionsWithNotice(sessionIds: readonly string[]): Promise<void> {
    const restored = await tryCommand(
        'Session restore failed',
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
    pushToast('info', describeRestoredSessions(restored.map((session) => session.displayTitle)));
}

export function unarchiveSessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    // Fire-and-forget: `unarchiveSessionsWithNotice` funnels its own failures into a toast via `tryCommand`.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void unarchiveSessionsWithNotice(sessionIds);
}

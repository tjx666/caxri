import type {
    SessionArchiveWorktreeChoice,
    SessionArchiveWorktreePlan,
    SessionRestorePlacement,
} from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { useDialogStore } from '../../stores/dialogs';
import { getBootstrap, getSelectedSession } from '../../stores/selectors';
import { pushToast, tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { recordClosedSession } from '../closed-items/recording';
import { describeRestoredSession, describeRestoredSessions } from './session-notice-copy';
import { sessionTitleForDisplay } from './session-title';

/**
 * Under `workbench.removeWorktreeOnArchive`, asks before archiving would remove a worktree whose pull request is not
 * merged; a merged one is removed without asking, so `undefined` leaves the decision to Server Core. A failed plan
 * archives without touching the worktree rather than blocking a reversible action.
 */
async function chooseArchivedWorktree(
    sessionId: string,
): Promise<SessionArchiveWorktreeChoice | 'cancel' | undefined> {
    let plan: SessionArchiveWorktreePlan | undefined;
    try {
        plan = await caxri.request('session.archiveWorktreePlan', { sessionId });
    } catch {
        plan = undefined;
    }
    const worktree = plan?.worktree;
    if (!worktree) return undefined;
    if (worktree.removal === 'automatic') return undefined;
    const title = getBootstrap()?.sessions.find((session) => session.id === sessionId)?.title;
    const answer = await tryCommand(translate('session.errors.archiveFailed'), () =>
        caxri.request('session.confirmArchiveWorktree', {
            branch: worktree.branch,
            rootPath: worktree.rootPath,
            sessionTitle:
                title === undefined
                    ? translate('session.untitled')
                    : sessionTitleForDisplay(title, translate),
            ...(worktree.pullRequestState && { pullRequestState: worktree.pullRequestState }),
        }),
    );
    // A dialog that never answered must not archive: the user did not get to choose.
    return answer?.choice ?? 'cancel';
}

/**
 * Archiving skips both a confirmation and a notice: it is reversible, and the row leaving the PrimarySidebar is the
 * feedback. Reopen Closed Item brings the Session back, and the Archived Sessions dialog lists it.
 */
async function archiveSessionQuietly(sessionId: string): Promise<void> {
    // Read from the bootstrap snapshot so an archive with the setting off never waits on the plan's pull request lookup.
    const worktree =
        getBootstrap()?.settings['workbench.removeWorktreeOnArchive'] === true
            ? await chooseArchivedWorktree(sessionId)
            : undefined;
    if (worktree === 'cancel') return;
    const archived = await tryCommand(
        translate('session.errors.archiveFailed'),
        () =>
            caxri.request('session.archive', {
                sessionId,
                ...(worktree && { worktree }),
            }),
        { refresh: refreshWorkbench },
    );
    if (!archived) return;
    recordClosedSession(sessionId);
}

export function archiveSession(sessionId: string): void {
    // Fire-and-forget: `archiveSessionQuietly` funnels its own failures into a toast via `tryCommand`.
    void archiveSessionQuietly(sessionId);
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
     * `unchanged` reverses one archive: Reopen Closed Item, or the automatic-archive notice's Undo. It restores the row
     * into a PrimarySidebar the user can see, so a notice would report a change they just watched happen. An explicit
     * restore is issued from a dialog wide enough to cover the sidebar, so without this the row reappears somewhere the
     * user cannot see and nothing says so.
     */
    if (!restored) return false;
    if (placement !== 'unchanged') pushToast('info', describeRestoredSession(restored.title));
    return true;
}

/**
 * Restores an archived Session back to the row it was archived from, resolving to whether the Server restored it.
 * Reopen Closed Editor or Session uses it: like the automatic-archive notice's Undo, it reverses one archive and so
 * reports no notice.
 */
export function restoreArchivedSession(sessionId: string): Promise<boolean> {
    return didRestoreSessionWithNotice(sessionId, 'unchanged');
}

/**
 * Restoring puts the Session back on top of its Project by default, so the row the user just asked for is the one they
 * see. Reversing a single archive passes `unchanged` instead (see {@link restoreArchivedSession}): a row that jumped to
 * the top would have rewritten the order the user arranged by dragging.
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

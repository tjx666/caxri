import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getBootstrap } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { pinnedSessions } from '../primary-sidebar/pinned-session-order';
import { didSelectSession } from './session-commands';

/**
 * Whether "Open in New Window" applies to `sessionId`. A window holds only the Session it shows, so that one cannot
 * leave (the window would be empty), and a Session another window already has open is reached by selecting it, which
 * brings that window forward. The row menu hides the entry on this answer; the Server's refusal stays the stale-state
 * fallback.
 */
export function canOpenSessionInNewWindow(
    input:
        | {
              selectedSessionId?: string;
              otherWindowOpenSessionIds?: readonly string[];
          }
        | undefined,
    sessionId: string,
): boolean {
    return (
        input?.selectedSessionId !== sessionId &&
        !(input?.otherWindowOpenSessionIds ?? []).includes(sessionId)
    );
}

/**
 * Opens a Session in a new window from the sidebar row menu. Main cascades the window from this one and the Server
 * moves the Session in one transaction, so a refused open leaves every window as it was.
 */
export async function openSessionInNewWindow(sessionId: string): Promise<void> {
    const bootstrap = getBootstrap();
    if (!bootstrap || !canOpenSessionInNewWindow(bootstrap, sessionId)) return;
    const result = await tryCommand(translate('session.errors.openInNewWindowFailed'), () =>
        caxri.request('window.tearOffSession', { sessionId }),
    );
    if (result?.opened) await refreshWorkbench();
}

/**
 * The Pinned Session `Cmd+<position>` switches to, in the Pinned group's order. Positions 1 to 8 are literal and 9
 * always means the last, the browser convention, so `Cmd+9` stays useful with more than nine pinned. A position past
 * the end selects nothing instead of wrapping.
 */
export function pinnedSessionTargetId(
    pinnedIds: readonly string[],
    position: number,
): string | undefined {
    if (!Number.isSafeInteger(position) || position < 1 || position > 9) return undefined;
    return position === 9 ? pinnedIds.at(-1) : pinnedIds[position - 1];
}

/**
 * `pendingTarget` is the Session the last `Cmd+<position>` asked for while its selection is still in flight. The
 * snapshot's `selectedSessionId` only moves once the Server answers, so without it `Cmd+1` then `Cmd+9` pressed quickly
 * would read the old selection, take the second press for a no-op, and land on the first target.
 */
const pinnedNavigation: { pendingTarget?: string } = {};

/**
 * `Cmd+1` to `Cmd+9`: shows the Pinned Session at that position. Selecting the Session already shown (or already
 * requested) is a no-op.
 */
export function openPinnedSessionAtPosition(position: number): void {
    const bootstrap = getBootstrap();
    if (!bootstrap) return;
    const target = pinnedSessionTargetId(
        pinnedSessions(bootstrap.sessions).map(({ id }) => id),
        position,
    );
    if (!target || target === (pinnedNavigation.pendingTarget ?? bootstrap.selectedSessionId))
        return;
    pinnedNavigation.pendingTarget = target;
    // Fire-and-forget: didSelectSession reports its own failures through a toast.
    // eslint-disable-next-line no-void -- intentional floating-promise discard
    void didSelectSession(target).finally(() => {
        if (pinnedNavigation.pendingTarget === target) delete pinnedNavigation.pendingTarget;
    });
}

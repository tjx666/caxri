import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { applyWindowOpenSessions, getOpenSessionIds } from '../../stores/open-sessions';
import { getBootstrap } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { sessionStatus } from '../primary-sidebar/session-status';
import { sessionAgentTerminal } from '../session/session-agent-terminal';
import { shouldKeepPreviewBeforeSelection } from './session-tabs-state';

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
 * Run before a Session selection: when the selection would replace a Preview entry whose Session is still running or
 * has unread attention, keeps that entry first so the Server opens the new Session as a fresh Preview instead (see
 * `shouldKeepPreviewBeforeSelection`). Does nothing in every other case.
 */
export async function keepBusyPreviewBeforeSelection(nextSessionId: string): Promise<void> {
    const bootstrap = getBootstrap();
    const previewId = bootstrap?.previewSessionId;
    if (!bootstrap || previewId === undefined) return;
    const session = bootstrap.sessions.find((item) => item.id === previewId);
    if (!session) return;
    const terminal = sessionAgentTerminal(session, bootstrap.terminals);
    if (
        shouldKeepPreviewBeforeSelection({
            nextSessionId,
            openSessionIds: getOpenSessionIds(),
            previewSessionId: previewId,
            statusKind: sessionStatus(session, terminal).kind,
        })
    )
        await keepSessionTab(previewId);
}

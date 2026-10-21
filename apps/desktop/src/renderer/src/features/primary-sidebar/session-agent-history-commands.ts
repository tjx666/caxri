import type { SessionAgentHistoryEntry } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { getBootstrap } from '../../stores/selectors';
import { tryCommand } from '../../stores/toasts';
import { refreshWorkbench } from '../../stores/workbench';
import { didSelectSession } from '../session/session-commands';
import { activateTerminal } from '../terminal/terminal-commands';

/**
 * Brings a conversation from a Session's history back on screen: opens the Session and selects the Terminal holding the
 * conversation, which the Server creates parked when the original Terminal is gone. Revealing a parked Agent Terminal
 * resumes the conversation, so nothing launches here.
 */
export async function reopenSessionConversation(
    sessionId: string,
    entry: Pick<SessionAgentHistoryEntry, 'agentSessionId' | 'provider'>,
): Promise<void> {
    const reopened = await tryCommand(
        translate('primarySidebar.card.history.reopenFailed'),
        () =>
            caxri.request('session.reopenConversation', {
                sessionId,
                provider: entry.provider,
                agentSessionId: entry.agentSessionId,
            }),
        { refresh: refreshWorkbench },
    );
    if (!reopened) return;
    await refreshWorkbench();
    if (getBootstrap()?.selectedSessionId !== sessionId && !(await didSelectSession(sessionId)))
        return;
    activateTerminal(reopened.terminalId);
}

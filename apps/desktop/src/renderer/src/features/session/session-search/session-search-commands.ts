import type { SessionSearchEntry } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { setSessionSearchOpen } from '../../../stores/dialogs';
import { pushToast, tryCommand } from '../../../stores/toasts';
import { refreshWorkbench } from '../../../stores/workbench';
import { handOffAgentChatFind } from '../../agent-chat/find/agent-chat-find-handoff';
import { openSession } from '../session-commands';
import { describeRestoredSession } from '../session-notice-copy';
import { sessionSearchAction, sessionSearchFindQuery } from './session-search-model';

/**
 * Runs a row's primary action and closes the overlay first, so the Session it opens is what the user sees next. A
 * message match also opens find in the conversation's Chat with the query, revealing the message that matched. An
 * archived Session is restored on top of its Project and opened; an external conversation becomes a new Session in the
 * Project containing its folder (adding that Project when none does) and is opened parked, ready to resume.
 */
export async function runSessionSearchAction(
    entry: SessionSearchEntry,
    query: string,
): Promise<void> {
    const action = sessionSearchAction(entry);
    if (!action) return;
    setSessionSearchOpen(false);
    const findQuery = sessionSearchFindQuery(entry, query);
    if (findQuery) handOffAgentChatFind(entry.agentSessionId!, findQuery);
    if (action === 'open') {
        openSession(entry.sessionId!);
        return;
    }
    if (action === 'restore') {
        const restored = await tryCommand(
            translate('session.errors.restoreFailed'),
            () =>
                caxri.request('session.unarchive', {
                    placement: 'top',
                    sessionId: entry.sessionId!,
                }),
            { refresh: refreshWorkbench },
        );
        if (!restored) return;
        pushToast('info', describeRestoredSession(restored.displayTitle));
        openSession(restored.id);
        return;
    }
    const imported = await tryCommand(
        translate('session.search.importFailed'),
        () =>
            caxri.request('session.importConversation', {
                provider: entry.provider!,
                agentSessionId: entry.agentSessionId!,
            }),
        { refresh: refreshWorkbench },
    );
    if (!imported) return;
    pushToast(
        'info',
        translate('session.search.imported', {
            title: entry.title || translate('session.search.untitledConversation'),
        }),
    );
    openSession(imported.sessionId);
}

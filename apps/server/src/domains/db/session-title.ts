import type { SessionRecord } from '@caxri/protocol';
import { CaxriError, normalizeTerminalTitle } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';

/**
 * Renames a Session and retitles its primary Agent Terminal to match, in one transaction.
 *
 * That tab is the Session's own face, so the two carry one name. Renaming only the Session left the tab showing the
 * Agent's conversation name until some later metadata probe happened to reconcile it, and when provider synchronization
 * was skipped (a provider without native rename, or an Agent that has not produced a session yet) no probe ever carried
 * the typed name, so the sidebar row and the tab named one Session two different things indefinitely. A secondary Agent
 * Terminal keeps its own conversation name: its tab is the only thing naming that conversation.
 *
 * The caller publishes the returned Session's `primaryAgentTerminalId` alongside the Session id, because the Renderer
 * refreshes Terminal records only for the ids a `state.changed` names.
 */
export function renameSessionWithPrimaryAgentTab(
    database: CaxriDatabaseConnection,
    sessionId: string,
    displayTitle: string,
): SessionRecord {
    const normalizedTitle = displayTitle.trim();
    if (!normalizedTitle) throw new CaxriError('VALIDATION', 'Session name is required');
    return database.transaction(() => {
        if (!database.sessions.rename(sessionId, normalizedTitle))
            throw new CaxriError('NOT_FOUND', 'Session not found');
        const renamed = database.sessions.get(sessionId)!;
        if (renamed.primaryAgentTerminalId) {
            /**
             * A Session title is not automatically a legal Terminal title: it may be up to 200 characters and this
             * function is also reached from the automatic path, where the title is whatever an Agent CLI wrote into its
             * own state store. `normalizeTerminalTitle` is the single bound every other `terminals.setTitle` caller
             * honors (120 characters, one line, no invisible formatting) and a title that survives none of it leaves
             * the tab on the name it already had.
             */
            const terminalTitle = normalizeTerminalTitle(normalizedTitle);
            if (terminalTitle)
                database.terminals.setTitle(renamed.primaryAgentTerminalId, terminalTitle);
        }
        return renamed;
    });
}

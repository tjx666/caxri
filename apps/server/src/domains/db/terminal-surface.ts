import type { TerminalSurface } from '@caxri/protocol';
import { initialAgentChatPermission } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';

/**
 * Switches a Terminal's surface. A Terminal switched to Chat for the first time starts from its Project's Chat default,
 * as a newly created Chat does; one that already chose a permission keeps it.
 */
export function switchTerminalSurface(
    database: CaxriDatabaseConnection,
    id: string,
    surface: TerminalSurface,
): void {
    database.terminals.updateSurface(id, surface);
    const terminal = database.terminals.get(id);
    if (surface !== 'chat' || !terminal?.provider || database.terminals.hasChatPermission(id))
        return;
    const projectId = database.sessions.get(terminal.sessionId)?.projectId;
    const defaults = projectId ? database.projects.get(projectId)?.chatDefaults : undefined;
    database.terminals.setChatPermission(
        id,
        initialAgentChatPermission(terminal.provider, defaults),
    );
}

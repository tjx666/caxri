import type { AgentProvider, TerminalSurface } from '@caxri/protocol';
import { initialAgentChatPermission } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';
import { defaultTerminalTitle } from './session-policy';

/**
 * Switches a Terminal's surface. A Terminal switched to Chat for the first time starts from its Project's Chat default,
 * as a newly created Chat does; one that already chose a permission keeps it.
 */
function switchTerminalSurface(
    database: CaxriDatabaseConnection,
    id: string,
    surface: TerminalSurface,
): void {
    database.terminals.updateSurface(id, surface);
    seedChatPermission(database, id);
}

function seedChatPermission(database: CaxriDatabaseConnection, id: string): void {
    const terminal = database.terminals.get(id);
    if (
        terminal?.surface !== 'chat' ||
        !terminal.provider ||
        database.terminals.hasChatPermission(id)
    )
        return;
    const projectId = database.sessions.get(terminal.sessionId)?.projectId;
    const defaults = projectId ? database.projects.get(projectId)?.chatDefaults : undefined;
    database.terminals.setChatPermission(
        id,
        initialAgentChatPermission(terminal.provider, defaults),
    );
}

/**
 * A Terminal's surface and Agent provider changes, each in one transaction; `CaxriDatabase.terminalSurfaces`.
 */
export class TerminalSurfaces {
    constructor(private readonly database: CaxriDatabaseConnection) {}

    switch(id: string, surface: TerminalSurface): void {
        this.database.transaction(() => switchTerminalSurface(this.database, id, surface));
    }

    /**
     * Moves a parked Agent Terminal onto another provider (see `TerminalsModel.replaceAgentProvider`) for a new
     * conversation. A Chat starts from its Project's Chat default for the new provider, since the previous provider's
     * permission names a mode the new one does not have. Returns whether the Terminal changed.
     */
    replaceAgentProvider(id: string, provider: AgentProvider): boolean {
        return this.database.transaction(() => {
            const terminals = this.database.terminals;
            if (!terminals.replaceAgentProvider(id, provider, defaultTerminalTitle(provider)))
                return false;
            seedChatPermission(this.database, id);
            return true;
        });
    }
}

import type { CaxriDatabaseConnection } from './database-connection';

export interface AgentCommanderRows {
    projectId: string;
    sessionId: string;
    terminalId?: string;
    /**
     * Sessions the Commander created in user Projects that still exist.
     */
    sessionIds: readonly string[];
}

/**
 * Reads the Agent Commander's system rows from `app_state`, trusting only IDs whose rows still exist. The Commander
 * Project is a real Project row so its Terminal reuses the ordinary PTY and Agent Endpoint machinery; this record is
 * what keeps it out of every Workbench-facing list without a schema column.
 */
export function agentCommanderRows(
    database: CaxriDatabaseConnection,
): AgentCommanderRows | undefined {
    const stored = database.appState.get('agentCommander');
    if (!stored) return undefined;
    const session = database.sessions.get(stored.sessionId);
    if (!database.projects.get(stored.projectId) || session?.projectId !== stored.projectId)
        return undefined;
    const terminal = stored.terminalId ? database.terminals.get(stored.terminalId) : undefined;
    return {
        projectId: stored.projectId,
        sessionId: stored.sessionId,
        terminalId: terminal?.sessionId === stored.sessionId ? terminal.id : undefined,
        sessionIds: stored.sessionIds.filter((id) => database.sessions.get(id)),
    };
}

/**
 * The Commander's system Project ID, which every Workbench-facing Project and Session list excludes. Unlike
 * `agentCommanderRows`, a stale Session reference does not matter here: the Project row alone decides exclusion.
 */
export function agentCommanderProjectId(database: CaxriDatabaseConnection): string | undefined {
    return database.appState.get('agentCommander')?.projectId;
}

import type { ProjectRecord, SessionRecord, TerminalKind, TerminalRecord } from '@shared/types';

export interface ArchivedSessionFilters {
    agent: TerminalKind | 'all';
    /** Project id or the UI sentinel `all`. */
    projectId: string;
    query: string;
}

interface ArchivedSessionItem {
    agent: TerminalKind;
    archivedAt: number;
    session: SessionRecord;
    terminal?: TerminalRecord;
}

interface ArchivedSessionGroup {
    project: ProjectRecord;
    sessions: ArchivedSessionItem[];
}

interface ArchivedSessionView {
    agentOptions: TerminalKind[];
    groups: ArchivedSessionGroup[];
    matchingCount: number;
    projectId: string;
    projectOptions: ProjectRecord[];
    totalCount: number;
}

const AGENT_ORDER: TerminalKind[] = ['shell', 'claude', 'codex'];

/** Builds the archived management read model from the existing bootstrap snapshot. */
export function deriveArchivedSessionView(
    projects: readonly ProjectRecord[],
    sessions: readonly SessionRecord[],
    terminals: readonly TerminalRecord[],
    filters: ArchivedSessionFilters,
): ArchivedSessionView {
    const terminalById = new Map(terminals.map((terminal) => [terminal.id, terminal]));
    const firstTerminalBySession = new Map<string, TerminalRecord>();
    for (const terminal of [...terminals].sort(
        (first, second) => first.orderIndex - second.orderIndex,
    ))
        if (!firstTerminalBySession.has(terminal.sessionId))
            firstTerminalBySession.set(terminal.sessionId, terminal);

    const sessionsByProject = new Map<string, ArchivedSessionItem[]>();
    for (const session of sessions) {
        if (session.archivedAt === undefined) continue;
        const terminal =
            (session.primaryAgentTerminalId
                ? terminalById.get(session.primaryAgentTerminalId)
                : undefined) ?? firstTerminalBySession.get(session.id);
        const item: ArchivedSessionItem = {
            agent: terminal?.kind ?? 'shell',
            archivedAt: session.archivedAt,
            session,
            terminal,
        };
        const projectSessions = sessionsByProject.get(session.projectId) ?? [];
        projectSessions.push(item);
        sessionsByProject.set(session.projectId, projectSessions);
    }

    const orderedProjects = [...projects].sort(
        (first, second) => first.orderIndex - second.orderIndex,
    );
    const projectOptions = orderedProjects.filter((project) => sessionsByProject.has(project.id));
    /**
     * Restore/delete can remove the selected Project's last archived Session. Normalize that stale
     * filter immediately so the control and results both return to the complete archive.
     */
    const projectId =
        filters.projectId === 'all' ||
        projectOptions.some((project) => project.id === filters.projectId)
            ? filters.projectId
            : 'all';

    const query = filters.query.trim().toLowerCase();
    const groups: ArchivedSessionGroup[] = [];
    for (const project of projectOptions) {
        if (projectId !== 'all' && projectId !== project.id) continue;
        const matching = sessionsByProject
            .get(project.id)!
            .filter(
                (item) =>
                    (filters.agent === 'all' || filters.agent === item.agent) &&
                    (!query || item.session.displayTitle.toLowerCase().includes(query)),
            )
            .sort(
                (first, second) =>
                    second.archivedAt - first.archivedAt ||
                    first.session.id.localeCompare(second.session.id),
            );
        if (matching.length > 0) groups.push({ project, sessions: matching });
    }

    return {
        agentOptions: AGENT_ORDER,
        groups,
        matchingCount: groups.reduce((count, group) => count + group.sessions.length, 0),
        projectId,
        projectOptions,
        totalCount: [...sessionsByProject.values()].reduce(
            (count, projectSessions) => count + projectSessions.length,
            0,
        ),
    };
}

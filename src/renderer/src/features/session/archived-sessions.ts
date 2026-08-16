import type { ProjectRecord, SessionRecord, TerminalKind, TerminalRecord } from '@shared/types';
import { groupBy, sortBy, sumBy } from 'es-toolkit';

export interface ArchivedSessionFilters {
    agent: TerminalKind | 'all';
    /**
     * Project id or the UI sentinel `all`.
     */
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

/**
 * Stable display order for Agent filter options; only kinds actually present in the archive show.
 */
const AGENT_ORDER: TerminalKind[] = ['shell', 'claude', 'codex'];

/**
 * Builds the archived management read model from the existing bootstrap snapshot.
 */
export function deriveArchivedSessionView(
    projects: readonly ProjectRecord[],
    sessions: readonly SessionRecord[],
    terminals: readonly TerminalRecord[],
    filters: ArchivedSessionFilters,
): ArchivedSessionView {
    const terminalById = new Map(terminals.map((terminal) => [terminal.id, terminal]));
    const firstTerminalBySession = new Map<string, TerminalRecord>();
    const orderedTerminals = sortBy(terminals, ['orderIndex']);
    for (const terminal of orderedTerminals)
        if (!firstTerminalBySession.has(terminal.sessionId))
            firstTerminalBySession.set(terminal.sessionId, terminal);

    const archivedSessions = sessions.filter(
        (session): session is SessionRecord & { archivedAt: number } =>
            session.archivedAt !== undefined,
    );
    const items: ArchivedSessionItem[] = archivedSessions.map((session) => {
        const terminal =
            (session.primaryAgentTerminalId
                ? terminalById.get(session.primaryAgentTerminalId)
                : undefined) ?? firstTerminalBySession.get(session.id);
        const agent = terminal?.kind ?? 'shell';
        return { agent, archivedAt: session.archivedAt, session, terminal };
    });
    const usedAgentKinds = new Set<TerminalKind>(items.map((item) => item.agent));
    const sessionsByProject = groupBy(items, (item) => item.session.projectId);

    const orderedProjects = sortBy(projects, ['orderIndex']);
    const projectOptions = orderedProjects.filter((project) =>
        Object.hasOwn(sessionsByProject, project.id),
    );
    /**
     * Restore/delete can remove the selected Project's last archived Session. Normalize that stale filter immediately
     * so the control and results both return to the complete archive.
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
        // `groupBy` types every key as present; `Object.hasOwn` keeps the runtime guard for projects
        // with no archived sessions without tripping no-unnecessary-condition.
        if (!Object.hasOwn(sessionsByProject, project.id)) continue;
        const projectSessions = sessionsByProject[project.id];
        const matching = projectSessions
            .filter(
                (item) =>
                    (filters.agent === 'all' || filters.agent === item.agent) &&
                    (!query || item.session.displayTitle.toLowerCase().includes(query)),
            )
            .toSorted(
                (first, second) =>
                    second.archivedAt - first.archivedAt ||
                    first.session.id.localeCompare(second.session.id),
            );
        if (matching.length > 0) groups.push({ project, sessions: matching });
    }

    return {
        /**
         * Derived from what is actually archived, not the fixed catalog: an Agent kind with zero archived Sessions
         * would otherwise be selectable and immediately dead-end into "no results" instead of not appearing as an
         * option at all.
         */
        agentOptions: AGENT_ORDER.filter((kind) => usedAgentKinds.has(kind)),
        groups,
        matchingCount: sumBy(groups, (group) => group.sessions.length),
        projectId,
        projectOptions,
        totalCount: sumBy(Object.values(sessionsByProject), (list) => list.length),
    };
}

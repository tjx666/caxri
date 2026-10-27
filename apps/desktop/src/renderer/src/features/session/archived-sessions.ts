import type { ProjectRecord, SessionRecord, TerminalKind, TerminalRecord } from '@caxri/protocol';
import { agentProviderIds, DEFAULT_SESSION_TITLE } from '@caxri/protocol';
import { sortBy } from 'es-toolkit';

export interface ArchivedSessionFilters {
    agent: TerminalKind | 'all';
    /**
     * Project id or the UI sentinel `all`.
     */
    projectId: string;
    query: string;
}

export interface ArchivedSessionItem {
    agent: TerminalKind;
    archivedAt: number;
    project: ProjectRecord;
    session: SessionRecord;
    terminal?: TerminalRecord;
}

export interface ArchivedSessionView {
    agentOptions: TerminalKind[];
    /**
     * Matching Sessions across every Project, newest archive first. The list is deliberately not grouped by Project:
     * the common visit is "find what I just archived", which must sit at the top regardless of which Project owns it.
     */
    items: ArchivedSessionItem[];
    matchingCount: number;
    projectId: string;
    projectOptions: ProjectRecord[];
    totalCount: number;
}

/**
 * Stable display order for Agent filter options; only kinds actually present in the archive show.
 */
const AGENT_ORDER: TerminalKind[] = ['shell', ...agentProviderIds];

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

    const projectById = new Map(projects.map((project) => [project.id, project]));
    const allItems: ArchivedSessionItem[] = [];
    for (const session of sessions) {
        if (session.archivedAt === undefined) continue;
        // A Session whose Project record is gone has no filter option or label to show under, so it stays hidden.
        const project = projectById.get(session.projectId);
        if (!project) continue;
        const terminal =
            (session.primaryAgentTerminalId
                ? terminalById.get(session.primaryAgentTerminalId)
                : undefined) ?? firstTerminalBySession.get(session.id);
        allItems.push({
            agent: terminal?.kind ?? 'shell',
            archivedAt: session.archivedAt,
            project,
            session,
            terminal,
        });
    }
    const usedAgentKinds = new Set<TerminalKind>(allItems.map((item) => item.agent));
    const archivedProjectIds = new Set(allItems.map((item) => item.project.id));
    const projectOptions = sortBy(projects, ['orderIndex']).filter((project) =>
        archivedProjectIds.has(project.id),
    );
    /**
     * Restore/delete can remove the selected Project's last archived Session. Normalize that stale filter immediately
     * so the control and results both return to the complete archive.
     */
    const projectId =
        filters.projectId === 'all' || archivedProjectIds.has(filters.projectId)
            ? filters.projectId
            : 'all';

    const query = filters.query.trim().toLowerCase();
    const items = allItems
        .filter(
            (item) =>
                (projectId === 'all' || projectId === item.project.id) &&
                (filters.agent === 'all' || filters.agent === item.agent) &&
                (!query || item.session.title.toLowerCase().includes(query)),
        )
        .toSorted(
            (first, second) =>
                second.archivedAt - first.archivedAt ||
                first.session.id.localeCompare(second.session.id),
        );

    return {
        /**
         * Derived from what is actually archived, not the fixed catalog: an Agent kind with zero archived Sessions
         * would otherwise be selectable and immediately dead-end into "no results" instead of not appearing as an
         * option at all.
         */
        agentOptions: AGENT_ORDER.filter((kind) => usedAgentKinds.has(kind)),
        items,
        matchingCount: items.length,
        projectId,
        projectOptions,
        totalCount: allItems.length,
    };
}

/**
 * A Session that never gained an Agent-derived or manual title still carries the neutral default. These accumulate from
 * abandoned launches, so the manager offers them as a one-click bulk selection.
 */
function isUntitledArchivedSession(item: ArchivedSessionItem): boolean {
    return item.session.title === DEFAULT_SESSION_TITLE;
}

export function visibleArchivedSessionIds(view: ArchivedSessionView): string[] {
    return view.items.map((item) => item.session.id);
}

export function untitledArchivedSessionIds(view: ArchivedSessionView): string[] {
    return view.items.filter(isUntitledArchivedSession).map((item) => item.session.id);
}

/**
 * Selection is scoped to what the current filters show. Narrowing a filter, or a restore/delete finishing elsewhere,
 * must never leave hidden Sessions inside the selection where a bulk action could act on them unseen.
 */
export function pruneArchivedSelection(
    selection: ReadonlySet<string>,
    view: ArchivedSessionView,
): ReadonlySet<string> {
    const pruned = selection.intersection(new Set(visibleArchivedSessionIds(view)));
    return pruned.size === selection.size ? selection : pruned;
}

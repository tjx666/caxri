import { Buffer } from 'node:buffer';

import type {
    AgentEndpointRef,
    MobileArchivedSessionsResult,
    MobileDashboardGroup,
    MobileDashboardParameters,
    MobileDashboardResult,
    ProjectQueryResult,
    SessionActivityGroupId,
    SessionPullRequests,
    SessionQueryResult,
    TerminalQueryResult,
} from '@caxri/protocol';
import {
    compareSessionActivityGroupRows,
    compareSessionPinnedOrder,
    isPinnedSession,
    isSessionAgentRunning,
    isSessionListedOnMobileHome,
    MOBILE_ARCHIVED_SESSIONS_MAX,
    MOBILE_DASHBOARD_GROUP_PAGE_SIZE,
    MOBILE_DASHBOARD_GROUPS,
    MOBILE_DASHBOARD_PAGE_MAX,
    MOBILE_MAX_PROJECT_GRANTS,
    SESSION_ACTIVITY_GROUP_ORDER,
    sessionActivityGroup,
} from '@caxri/protocol';

export const MOBILE_DASHBOARD_MAX_BYTES = 48 * 1024;
const MAXIMUM_REPLY_TOTAL = 4_096;

const title = (value: string): string => {
    let result = '';
    for (const character of value) {
        if (Buffer.byteLength(result + character, 'utf8') > 100) break;
        result += character;
    }
    return result || 'Untitled';
};

type DashboardSession = SessionQueryResult['sessions'][number];
type DashboardTerminal = TerminalQueryResult['terminals'][number];
type DashboardRow = MobileDashboardResult['sessions'][number];

/**
 * The status group a Session sorts into, read from its Primary Agent Terminal the way Desktop's Activity view and the
 * phone's own list read it.
 */
const sessionGroup = (
    session: DashboardSession,
    terminal: DashboardTerminal | undefined,
): SessionActivityGroupId =>
    sessionActivityGroup({
        hasPendingAttention: session.hasPendingAttention,
        isDetached: terminal?.lastProcessState === 'detached',
        isRunning: isSessionAgentRunning(session, terminal),
        // A Chat waiting for a plan limit to reset is idle, as on Desktop and the phone's own list.
        isUsageWaiting: terminal?.usageLimitWaitAt !== undefined,
    });

interface MobileRowInput {
    projects: ProjectQueryResult['projects'];
    sessions: SessionQueryResult['sessions'];
    terminals: TerminalQueryResult['terminals'];
    resolveAgentEndpoint?: (terminalId: string) => AgentEndpointRef | undefined;
    /**
     * Desktop's cached pull request snapshot, read once for the whole list so no row costs a request of its own.
     */
    pullRequests?: SessionPullRequests['pullRequests'];
    /**
     * Every Project including the linked worktree Projects a paired device cannot list, used only to name the worktree
     * of a Session the device may already see.
     */
    worktreeProjects?: ReadonlyArray<{ id: string; title: string }>;
}

/**
 * The row projection the home list and `mobile.session.show` share, with its lookups built once per read.
 */
const createRowProjector = (input: MobileRowInput) => {
    const projectTitles = new Map(input.projects.map((project) => [project.id, project.title]));
    const terminals = new Map(input.terminals.map((terminal) => [terminal.id, terminal]));
    const worktreeTitles = new Map(
        (input.worktreeProjects ?? []).map((project) => [project.id, project.title]),
    );
    const shellTerminals = new Map<string, DashboardTerminal>();
    for (const terminal of input.terminals) {
        if (terminal.kind === 'shell' && !shellTerminals.has(terminal.sessionId))
            shellTerminals.set(terminal.sessionId, terminal);
    }
    const archivedSessionIds = new Set(
        input.sessions
            .filter((session) => session.archivedAt !== undefined)
            .map((session) => session.id),
    );
    const primaryTerminalOf = (session: DashboardSession) =>
        session.primaryAgentTerminalId
            ? terminals.get(session.primaryAgentTerminalId)
            : shellTerminals.get(session.id);
    const isCreatorArchived = (session: DashboardSession): boolean =>
        session.createdBySessionId !== undefined &&
        archivedSessionIds.has(session.createdBySessionId);
    const project = (session: DashboardSession): DashboardRow => {
        const primaryTerminal = primaryTerminalOf(session);
        const mobileTerminal = primaryTerminal
            ? {
                  id: primaryTerminal.id,
                  sessionId: primaryTerminal.sessionId,
                  kind: primaryTerminal.kind,
                  ...(primaryTerminal.provider && { provider: primaryTerminal.provider }),
                  lastProcessState: primaryTerminal.lastProcessState,
                  ...(primaryTerminal.surface && { surface: primaryTerminal.surface }),
                  ...(primaryTerminal.failureReason && {
                      failureReason: primaryTerminal.failureReason,
                  }),
                  ...(primaryTerminal.usageLimitWaitAt !== undefined && {
                      usageLimitWaitAt: primaryTerminal.usageLimitWaitAt,
                  }),
                  ...(primaryTerminal.agentOperation !== undefined && {
                      agentOperation: primaryTerminal.agentOperation,
                  }),
              }
            : undefined;
        const pullRequest = input.pullRequests?.[session.id];
        // Desktop's rule: a Session bound to another Workbench Root works in that linked worktree.
        const worktreeTitle =
            session.workbenchRootProjectId === session.projectId
                ? undefined
                : worktreeTitles.get(session.workbenchRootProjectId);
        return {
            id: session.id,
            projectId: session.projectId,
            title: title(session.title),
            projectTitle: title(projectTitles.get(session.projectId) ?? 'Project'),
            createdAt: session.createdAt,
            ...(session.createdBySessionId !== undefined && {
                createdBySessionId: session.createdBySessionId,
            }),
            ...(session.createdByRelation !== undefined && {
                createdByRelation: session.createdByRelation,
            }),
            ...(isCreatorArchived(session) && { createdBySessionArchived: true }),
            lastVisitedAt: session.lastVisitedAt,
            sessionActivityAt: session.sessionActivityAt,
            ...(session.pinnedAt !== undefined && { pinnedAt: session.pinnedAt }),
            ...(session.pinnedOrder !== undefined && { pinnedOrder: session.pinnedOrder }),
            agentActivityState: session.agentActivityState,
            ...(session.primaryAgentTerminalId && {
                primaryAgentTerminalId: session.primaryAgentTerminalId,
                ...(input.resolveAgentEndpoint?.(session.primaryAgentTerminalId) && {
                    primaryAgentEndpoint: input.resolveAgentEndpoint(
                        session.primaryAgentTerminalId,
                    ),
                }),
            }),
            attentionGeneration: session.attentionGeneration,
            hasUnread: session.hasUnread,
            hasPendingAttention: session.hasPendingAttention,
            ...(session.attentionResolvedAt !== undefined && {
                attentionResolvedAt: session.attentionResolvedAt,
            }),
            ...(session.turnStartedAt !== undefined && { turnStartedAt: session.turnStartedAt }),
            ...(session.lastAttentionKind !== undefined && {
                lastAttentionKind: session.lastAttentionKind,
            }),
            ...(pullRequest && {
                pullRequest: {
                    number: pullRequest.number,
                    state: pullRequest.state,
                    ...(pullRequest.deployment && { deployment: pullRequest.deployment }),
                },
            }),
            ...(worktreeTitle && { worktreeTitle: title(worktreeTitle) }),
            ...(mobileTerminal && { primaryTerminal: mobileTerminal }),
        };
    };
    return { isCreatorArchived, primaryTerminalOf, project };
};

/**
 * One Session as the home list projects it, for `mobile.session.show`. It answers a Session the home list hides too (a
 * second opinion opened from its creator's timeline), since the reader reached it on purpose.
 */
export const buildMobileSessionRow = (
    input: MobileRowInput & { session: DashboardSession },
): DashboardRow => createRowProjector(input).project(input.session);

/**
 * When each Project last saw work or a visit, so the phone can tell a Project in use from a dormant one: the later of
 * the Session Activity clock (an Agent turn, a new Session) and the last time the user opened one of its Sessions.
 */
const projectLastActivity = (sessions: readonly DashboardSession[]): Map<string, number> => {
    const lastActivityByProject = new Map<string, number>();
    for (const session of sessions) {
        if (session.archivedAt !== undefined) continue;
        lastActivityByProject.set(
            session.projectId,
            Math.max(
                lastActivityByProject.get(session.projectId) ?? 0,
                session.sessionActivityAt,
                session.lastVisitedAt,
            ),
        );
    }
    return lastActivityByProject;
};

/**
 * Builds one frame-safe, principal-scoped read of the phone's Session home.
 *
 * The rows are the Sessions the home list shows (`isSessionListedOnMobileHome`, decided over every Session the device
 * may see), narrowed to `projectId`, split into the list's groups (a pinned Session only under Pinned), and ordered
 * inside each group the way Desktop's Activity view orders it. A first read answers each group's first
 * `MOBILE_DASHBOARD_GROUP_PAGE_SIZE` rows; a `page` read answers one group from `offset`. Each group's total travels
 * with the reply, so the phone offers to load the rows it does not hold.
 *
 * The reply byte budget still bounds every read. A first read takes its rows one per group in turn, so when the budget
 * stops it every group keeps a share and still holds an unbroken prefix of its order, which a `page` read continues.
 */
export const buildMobileDashboard = (
    input: MobileRowInput & {
        hostDisplayName: string;
        deviceRole: MobileDashboardResult['deviceRole'];
        query?: MobileDashboardParameters;
    },
): MobileDashboardResult => {
    const lastActivityByProject = projectLastActivity(input.sessions);
    const visibleProjects = input.projects.slice(0, MOBILE_MAX_PROJECT_GRANTS).map((project) => ({
        id: project.id,
        title: title(project.title),
        ...(lastActivityByProject.has(project.id) && {
            lastActivityAt: lastActivityByProject.get(project.id)!,
        }),
    }));
    const visibleProjectIds = new Set(visibleProjects.map(({ id }) => id));
    const rows = createRowProjector(input);
    const visibleActive = input.sessions.filter(
        (session) => session.archivedAt === undefined && visibleProjectIds.has(session.projectId),
    );
    const visibleActiveIds = new Set(visibleActive.map(({ id }) => id));
    const projectId = input.query?.projectId;
    const groups: Record<MobileDashboardGroup, DashboardSession[]> = {
        pinned: [],
        attention: [],
        working: [],
        idle: [],
    };
    for (const session of visibleActive) {
        if (projectId !== undefined && session.projectId !== projectId) continue;
        // Decided over every visible Session, not only the filtered Project, so a row hides under the same creator
        // whichever Project the phone shows.
        const isHomeRow = isSessionListedOnMobileHome(
            { ...session, createdBySessionArchived: rows.isCreatorArchived(session) },
            visibleActiveIds,
        );
        if (!isHomeRow) continue;
        if (isPinnedSession(session)) groups.pinned.push(session);
        else groups[sessionGroup(session, rows.primaryTerminalOf(session))].push(session);
    }
    groups.pinned.sort(compareSessionPinnedOrder);
    for (const group of SESSION_ACTIVITY_GROUP_ORDER)
        groups[group].sort((left, right) => compareSessionActivityGroupRows(group, left, right));
    const capped = (count: number): number => Math.min(count, MAXIMUM_REPLY_TOTAL);
    const groupTotals: MobileDashboardResult['groupTotals'] = {
        pinned: capped(groups.pinned.length),
        attention: capped(groups.attention.length),
        working: capped(groups.working.length),
        idle: capped(groups.idle.length),
    };
    const total = capped(
        MOBILE_DASHBOARD_GROUPS.reduce((sum, group) => sum + groups[group].length, 0),
    );
    const page = input.query?.page;
    const candidates: Array<{ group: MobileDashboardGroup; session: DashboardSession }> = [];
    if (page) {
        const pageRows = groups[page.group].slice(
            page.offset,
            page.offset + MOBILE_DASHBOARD_PAGE_MAX,
        );
        for (const session of pageRows) candidates.push({ group: page.group, session });
    } else
        for (let index = 0; index < MOBILE_DASHBOARD_GROUP_PAGE_SIZE; index += 1)
            for (const group of MOBILE_DASHBOARD_GROUPS) {
                const session = groups[group].at(index);
                if (session) candidates.push({ group, session });
            }
    const reply = {
        hostDisplayName: input.hostDisplayName,
        deviceRole: input.deviceRole,
        projects: visibleProjects,
        sessions: [] as DashboardRow[],
        total,
        groupTotals,
        truncated: true,
    };
    const accepted: Record<MobileDashboardGroup, DashboardRow[]> = {
        pinned: [],
        attention: [],
        working: [],
        idle: [],
    };
    // Each row adds its JSON, and every row after the first a separating comma, to the reply measured with no rows.
    let bytes = Buffer.byteLength(JSON.stringify(reply), 'utf8');
    let count = 0;
    for (const { group, session } of candidates) {
        const candidate = rows.project(session);
        const size = Buffer.byteLength(JSON.stringify(candidate), 'utf8') + (count > 0 ? 1 : 0);
        if (bytes + size > MOBILE_DASHBOARD_MAX_BYTES) break;
        bytes += size;
        count += 1;
        accepted[group].push(candidate);
    }
    // Rows travel in list order, whatever order the budget took them in.
    const sessions = MOBILE_DASHBOARD_GROUPS.flatMap((group) => accepted[group]);
    return { ...reply, sessions, truncated: sessions.length < total };
};

/**
 * Projects the principal's archived Sessions for the phone's restore list, newest archive first, bounded by count and
 * by the same frame budget as the dashboard.
 */
export const buildMobileArchivedSessions = (input: {
    projects: ProjectQueryResult['projects'];
    sessions: SessionQueryResult['sessions'];
    terminals: TerminalQueryResult['terminals'];
}): MobileArchivedSessionsResult => {
    const projects = new Map(input.projects.map((project) => [project.id, project]));
    const terminals = new Map(input.terminals.map((terminal) => [terminal.id, terminal]));
    const archived = input.sessions
        .filter(
            (session): session is typeof session & { archivedAt: number } =>
                session.archivedAt !== undefined && projects.has(session.projectId),
        )
        .toSorted(
            (left, right) => right.archivedAt - left.archivedAt || left.id.localeCompare(right.id),
        );
    const sessions: MobileArchivedSessionsResult['sessions'] = [];
    let bytes = 0;
    for (const session of archived) {
        if (sessions.length >= MOBILE_ARCHIVED_SESSIONS_MAX) break;
        const agentKind = session.primaryAgentTerminalId
            ? terminals.get(session.primaryAgentTerminalId)?.kind
            : undefined;
        const candidate: MobileArchivedSessionsResult['sessions'][number] = {
            id: session.id,
            projectId: session.projectId,
            title: title(session.title),
            projectTitle: title(projects.get(session.projectId)?.title ?? 'Project'),
            archivedAt: session.archivedAt,
            ...(agentKind && { agentKind }),
        };
        const size = Buffer.byteLength(JSON.stringify(candidate), 'utf8') + 1;
        if (bytes + size > MOBILE_DASHBOARD_MAX_BYTES - 1_024) break;
        bytes += size;
        sessions.push(candidate);
    }
    return {
        sessions,
        total: Math.min(archived.length, 4_096),
        truncated: sessions.length < archived.length,
    };
};

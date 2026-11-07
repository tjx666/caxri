import { Buffer } from 'node:buffer';

import type {
    AgentEndpointRef,
    MobileArchivedSessionsResult,
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
    MOBILE_ARCHIVED_SESSIONS_MAX,
    SESSION_ACTIVITY_GROUP_ORDER,
    sessionActivityGroup,
} from '@caxri/protocol';

export const MOBILE_DASHBOARD_MAX_BYTES = 48 * 1024;
const MAXIMUM_DASHBOARD_SESSIONS = 64;

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

/**
 * The phone's list order, decided here because the dashboard is capped: pinned Sessions first, then the status groups
 * Desktop's Activity view uses, then the shared in-group order. Whatever the cap drops is the least urgent, least
 * recent work, never a pinned or attention Session.
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

/**
 * Builds one frame-safe, principal-scoped mobile projection. Pinned, attention, and running Sessions are ordered before
 * recency, so the bounded companion surface preserves the work that needs action instead of inheriting Desktop-scale
 * lists.
 */
export const buildMobileDashboard = (input: {
    hostDisplayName: string;
    deviceRole: MobileDashboardResult['deviceRole'];
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
}): MobileDashboardResult => {
    const lastActivityByProject = new Map<string, number>();
    for (const session of input.sessions) {
        if (session.archivedAt !== undefined) continue;
        lastActivityByProject.set(
            session.projectId,
            Math.max(lastActivityByProject.get(session.projectId) ?? 0, session.lastVisitedAt),
        );
    }
    const visibleProjects = input.projects.slice(0, 128).map((project) => ({
        id: project.id,
        title: title(project.title),
        ...(lastActivityByProject.has(project.id) && {
            lastActivityAt: lastActivityByProject.get(project.id)!,
        }),
    }));
    const projects = new Map(visibleProjects.map((project) => [project.id, project]));
    const terminals = new Map(input.terminals.map((terminal) => [terminal.id, terminal]));
    const worktreeTitles = new Map(
        (input.worktreeProjects ?? []).map((project) => [project.id, project.title]),
    );
    const shellTerminals = new Map<string, (typeof input.terminals)[number]>();
    for (const terminal of input.terminals) {
        if (terminal.kind === 'shell' && !shellTerminals.has(terminal.sessionId))
            shellTerminals.set(terminal.sessionId, terminal);
    }
    const primaryTerminalOf = (session: DashboardSession) =>
        session.primaryAgentTerminalId
            ? terminals.get(session.primaryAgentTerminalId)
            : shellTerminals.get(session.id);
    const groups = new Map(
        input.sessions.map((session) => [
            session.id,
            sessionGroup(session, primaryTerminalOf(session)),
        ]),
    );
    const rank = (session: DashboardSession): number =>
        isPinnedSession(session)
            ? -1
            : SESSION_ACTIVITY_GROUP_ORDER.indexOf(groups.get(session.id)!);
    const rowOrder = (session: DashboardSession) => ({
        ...session,
    });
    const active = input.sessions
        .filter((session) => session.archivedAt === undefined && projects.has(session.projectId))
        .toSorted(
            (left, right) =>
                rank(left) - rank(right) ||
                (isPinnedSession(left)
                    ? compareSessionPinnedOrder(left, right)
                    : compareSessionActivityGroupRows(
                          groups.get(left.id)!,
                          rowOrder(left),
                          rowOrder(right),
                      )),
        );
    const sessions: MobileDashboardResult['sessions'] = [];
    for (const session of active) {
        if (sessions.length >= MAXIMUM_DASHBOARD_SESSIONS) break;
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
        const candidate: MobileDashboardResult['sessions'][number] = {
            id: session.id,
            projectId: session.projectId,
            title: title(session.title),
            projectTitle: title(projects.get(session.projectId)?.title ?? 'Project'),
            createdAt: session.createdAt,
            ...(session.createdBySessionId !== undefined && {
                createdBySessionId: session.createdBySessionId,
            }),
            ...(session.createdByRelation !== undefined && {
                createdByRelation: session.createdByRelation,
            }),
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
        const next = [...sessions, candidate];
        const projected = {
            hostDisplayName: input.hostDisplayName,
            deviceRole: input.deviceRole,
            projects: visibleProjects,
            sessions: next,
            total: active.length,
            truncated: true,
        };
        if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > MOBILE_DASHBOARD_MAX_BYTES)
            break;
        sessions.push(candidate);
    }
    return {
        hostDisplayName: input.hostDisplayName,
        deviceRole: input.deviceRole,
        projects: visibleProjects,
        sessions,
        total: active.length,
        truncated: sessions.length < active.length,
    };
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

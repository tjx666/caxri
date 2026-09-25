import { Buffer } from 'node:buffer';

import type {
    AgentEndpointRef,
    MobileDashboardResult,
    ProjectQueryResult,
    SessionQueryResult,
    TerminalQueryResult,
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

const priority = (session: SessionQueryResult['sessions'][number]): number => {
    if (
        session.hasUnread ||
        session.lastActivityState === 'waiting' ||
        session.lastActivityState === 'failed'
    )
        return 0;
    return session.lastActivityState === 'running' ? 1 : 2;
};

/**
 * Builds one frame-safe, principal-scoped mobile projection. Attention and running Sessions are ordered before recency,
 * so the bounded companion surface preserves the work that needs action instead of inheriting Desktop-scale lists.
 */
export const buildMobileDashboard = (input: {
    hostDisplayName: string;
    deviceRole: MobileDashboardResult['deviceRole'];
    projects: ProjectQueryResult['projects'];
    sessions: SessionQueryResult['sessions'];
    terminals: TerminalQueryResult['terminals'];
    resolveAgentEndpoint?: (terminalId: string) => AgentEndpointRef | undefined;
}): MobileDashboardResult => {
    const lastActivityByProject = new Map<string, number>();
    for (const session of input.sessions) {
        if (session.archivedAt !== undefined) continue;
        lastActivityByProject.set(
            session.projectId,
            Math.max(lastActivityByProject.get(session.projectId) ?? 0, session.lastOpenedAt),
        );
    }
    const visibleProjects = input.projects.slice(0, 128).map((project) => ({
        id: project.id,
        displayTitle: title(project.displayTitle),
        ...(lastActivityByProject.has(project.id) && {
            lastActivityAt: lastActivityByProject.get(project.id)!,
        }),
    }));
    const projects = new Map(visibleProjects.map((project) => [project.id, project]));
    const terminals = new Map(input.terminals.map((terminal) => [terminal.id, terminal]));
    const shellTerminals = new Map<string, (typeof input.terminals)[number]>();
    for (const terminal of input.terminals) {
        if (terminal.kind === 'shell' && !shellTerminals.has(terminal.sessionId))
            shellTerminals.set(terminal.sessionId, terminal);
    }
    const active = input.sessions
        .filter((session) => session.archivedAt === undefined && projects.has(session.projectId))
        .toSorted(
            (left, right) =>
                priority(left) - priority(right) ||
                Number(right.hasUnread) - Number(left.hasUnread) ||
                right.lastOpenedAt - left.lastOpenedAt ||
                left.id.localeCompare(right.id),
        );
    const sessions: MobileDashboardResult['sessions'] = [];
    for (const session of active) {
        if (sessions.length >= MAXIMUM_DASHBOARD_SESSIONS) break;
        const primaryTerminal = session.primaryAgentTerminalId
            ? terminals.get(session.primaryAgentTerminalId)
            : shellTerminals.get(session.id);
        const mobileTerminal = primaryTerminal
            ? {
                  id: primaryTerminal.id,
                  sessionId: primaryTerminal.sessionId,
                  kind: primaryTerminal.kind,
                  ...(primaryTerminal.provider && { provider: primaryTerminal.provider }),
                  lastProcessState: primaryTerminal.lastProcessState,
                  ...(primaryTerminal.failureReason && {
                      failureReason: primaryTerminal.failureReason,
                  }),
              }
            : undefined;
        const candidate: MobileDashboardResult['sessions'][number] = {
            id: session.id,
            projectId: session.projectId,
            displayTitle: title(session.displayTitle),
            projectTitle: title(projects.get(session.projectId)?.displayTitle ?? 'Project'),
            lastOpenedAt: session.lastOpenedAt,
            lastActivityState: session.lastActivityState,
            ...(session.primaryAgentTerminalId && {
                primaryAgentTerminalId: session.primaryAgentTerminalId,
                ...(input.resolveAgentEndpoint?.(session.primaryAgentTerminalId) && {
                    primaryAgentEndpoint: input.resolveAgentEndpoint(
                        session.primaryAgentTerminalId,
                    ),
                }),
            }),
            attentionEpoch: session.attentionEpoch,
            hasUnread: session.hasUnread,
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

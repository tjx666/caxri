import type { Principal } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { buildMobileDashboard } from './dashboard';
import { sessionForPrincipal } from './session-management';

type DashboardProjection = Omit<
    Parameters<typeof buildMobileDashboard>[0],
    'projects' | 'sessions' | 'terminals'
>;

/**
 * The Session home: every Project, Session, and Terminal the principal may see, narrowed to a paired device's granted
 * Projects before projection.
 */
export async function readMobileDashboard(
    domainService: ServerDomainService,
    principal: Principal,
    projection: DashboardProjection,
) {
    const [projects, sessions, terminals] = await Promise.all([
        domainService.request('project.queryForPrincipal', {
            principal,
            query: { mode: 'list' },
        }),
        domainService.request('session.queryForPrincipal', {
            principal,
            query: { mode: 'list' },
        }),
        domainService.request('terminal.queryForPrincipal', {
            principal,
            query: { mode: 'list' },
        }),
    ]);
    const grantedProjectIds =
        principal.kind === 'paired-device' ? new Set(principal.projectIds) : undefined;
    const visibleProjects = grantedProjectIds
        ? projects.projects.filter((project) => grantedProjectIds.has(project.id))
        : projects.projects;
    return buildMobileDashboard({
        ...projection,
        projects: visibleProjects,
        sessions: sessions.sessions,
        terminals: terminals.terminals,
    });
}

/**
 * One Session as the dashboard projects it, for a deep link or a Session screen refresh. `reauthorize` runs after the
 * reads so a revoke that lands meanwhile is not answered with the Session.
 */
export async function showMobileSession(
    domainService: ServerDomainService,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    sessionId: string,
    projection: DashboardProjection,
    reauthorize: () => unknown,
) {
    const session = await sessionForPrincipal(domainService, principal, sessionId);
    const [projects, terminals] = await Promise.all([
        domainService.request('project.queryForPrincipal', {
            principal,
            query: { mode: 'show', selector: session.projectId },
        }),
        session.primaryAgentTerminalId
            ? domainService.request('terminal.queryForPrincipal', {
                  principal,
                  query: { mode: 'show', selector: session.primaryAgentTerminalId },
              })
            : domainService.request('terminal.queryForPrincipal', {
                  principal,
                  query: { mode: 'list', sessionId: session.id },
              }),
    ]);
    const projected = buildMobileDashboard({
        ...projection,
        projects: projects.projects,
        sessions: [session],
        terminals: terminals.terminals,
    }).sessions.at(0);
    if (!projected) throw new CaxriError('NOT_FOUND', 'Session not found');
    reauthorize();
    return { session: projected };
}

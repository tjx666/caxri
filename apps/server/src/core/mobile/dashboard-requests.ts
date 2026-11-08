import type { Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { buildMobileDashboard } from './dashboard';
import { sessionForPrincipal } from './session-management';

type DashboardProjection = Omit<
    Parameters<typeof buildMobileDashboard>[0],
    'projects' | 'pullRequests' | 'sessions' | 'terminals' | 'worktreeProjects'
>;

/**
 * The row's pull request and worktree label come from reads Desktop already keeps warm: the cached pull request
 * snapshot (a stale entry refreshes in the background, as for a Desktop poll) and the full Project list.
 */
async function readRowContext(domainService: ServerDomainService) {
    const [pullRequests, allProjects] = await Promise.all([
        domainService.request('session.pullRequests', {}),
        domainService.request('project.list', {}),
    ]);
    return {
        pullRequests: pullRequests.pullRequests,
        worktreeProjects: allProjects.projects
            // The in-process handler answers full Project records; the union type only narrows per view.
            .filter(
                (project) => 'ownerProjectId' in project && project.ownerProjectId !== undefined,
            )
            .map(({ id, title }) => ({ id, title })),
    };
}

/**
 * The Session home: every Project, Session, and Terminal the principal may see, narrowed to a paired device's granted
 * Projects before projection.
 */
async function readMobileDashboard(
    domainService: ServerDomainService,
    principal: Principal,
    projection: DashboardProjection,
) {
    const [projects, sessions, terminals, rowContext] = await Promise.all([
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
        readRowContext(domainService),
    ]);
    const grantedProjectIds =
        principal.kind === 'paired-device' ? new Set(principal.projectIds) : undefined;
    const visibleProjects = grantedProjectIds
        ? projects.projects.filter((project) => grantedProjectIds.has(project.id))
        : projects.projects;
    return buildMobileDashboard({
        ...projection,
        ...rowContext,
        projects: visibleProjects,
        sessions: sessions.sessions,
        terminals: terminals.terminals,
    });
}

/**
 * One Session as the dashboard projects it, for a deep link or a Session screen refresh. `reauthorize` runs after the
 * reads so a revoke that lands meanwhile is not answered with the Session.
 */
async function showMobileSession(
    domainService: ServerDomainService,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    sessionId: string,
    projection: DashboardProjection,
    reauthorize: () => unknown,
) {
    const session = await sessionForPrincipal(domainService, principal, sessionId);
    const [projects, terminals, rowContext] = await Promise.all([
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
        readRowContext(domainService),
    ]);
    const projected = buildMobileDashboard({
        ...projection,
        ...rowContext,
        projects: projects.projects,
        sessions: [session],
        terminals: terminals.terminals,
    }).sessions.at(0);
    if (!projected) throw new CaxriError('NOT_FOUND', 'Session not found');
    reauthorize();
    return { session: projected };
}

/**
 * The two reads that name the computer: the Session home and one Session's row. A paired device must still hold a role
 * that allows the method; Desktop's own principal reads the home with no device role.
 */
export function invokeMobileDashboardRequest(
    request: Extract<ServerRequest, { method: 'mobile.dashboard' | 'mobile.session.show' }>,
    principal: Principal,
    domainService: ServerDomainService,
    context: Pick<DashboardProjection, 'hostDisplayName' | 'resolveAgentEndpoint'> & {
        currentPairedPrincipal: (
            principal: Principal,
            method: string,
        ) => Extract<Principal, { kind: 'paired-device' }>;
    },
) {
    const { currentPairedPrincipal, ...projection } = context;
    if (request.method === 'mobile.dashboard') {
        const paired =
            principal.kind === 'paired-device'
                ? currentPairedPrincipal(principal, request.method)
                : undefined;
        return readMobileDashboard(domainService, principal, {
            ...projection,
            deviceRole: paired?.role ?? null,
        });
    }
    const paired = currentPairedPrincipal(principal, request.method);
    return showMobileSession(
        domainService,
        paired,
        request.params.sessionId,
        { ...projection, deviceRole: paired.role },
        () => currentPairedPrincipal(paired, request.method),
    );
}

import type { Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { buildMobileArchivedSessions } from './dashboard';

export type MobileSessionManagementRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.session.archive'
            | 'mobile.session.rename'
            | 'mobile.session.restore'
            | 'mobile.session.setPinned';
    }
>;

export const sessionForPrincipal = async (
    domainService: ServerDomainService,
    principal: Principal,
    sessionId: string,
) => {
    const result = await domainService.request('session.queryForPrincipal', {
        principal,
        query: { mode: 'show', selector: sessionId },
    });
    const session = result.sessions.at(0);
    if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
    return session;
};

/**
 * Lists archived Sessions of the Projects granted to a paired device. The principal-scoped queries already bound the
 * records; the explicit grant filter keeps a Desktop-scale Project list out of the projection.
 */
export const readMobileArchivedSessions = async (
    domainService: ServerDomainService,
    principal: Extract<Principal, { kind: 'paired-device' }>,
) => {
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
    const grantedProjectIds = new Set(principal.projectIds);
    return buildMobileArchivedSessions({
        projects: projects.projects.filter((project) => grantedProjectIds.has(project.id)),
        sessions: sessions.sessions,
        terminals: terminals.terminals,
    });
};

/**
 * Session management reuses Desktop's own handlers so rename, archive, restore, and pinning keep one implementation;
 * the gateway only adds the grant check in front of them. Restore lands at the top of the Project, matching Desktop's
 * dialog.
 */
export const applyMobileSessionManagement = async (
    domainService: ServerDomainService,
    principal: Principal,
    request: MobileSessionManagementRequest,
    signal: AbortSignal,
): Promise<{ sessionId: string }> => {
    const { sessionId } = request.params;
    await sessionForPrincipal(domainService, principal, sessionId);
    switch (request.method) {
        case 'mobile.session.rename':
            await domainService.requestWithSignal(
                'session.rename',
                { sessionId, displayTitle: request.params.displayTitle },
                signal,
            );
            break;
        case 'mobile.session.archive':
            await domainService.requestWithSignal('session.archive', { sessionId }, signal);
            break;
        case 'mobile.session.restore':
            await domainService.requestWithSignal(
                'session.unarchive',
                { sessionId, placement: 'top' },
                signal,
            );
            break;
        case 'mobile.session.setPinned':
            await domainService.requestWithSignal(
                'session.setPinned',
                { sessionId, pinned: request.params.pinned },
                signal,
            );
            break;
    }
    return { sessionId };
};

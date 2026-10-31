import type { Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { switchMobileTerminalSurface } from './action-requests';
import { buildMobileArchivedSessions } from './dashboard';

export type MobileSessionManagementRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.session.archive'
            | 'mobile.session.delete'
            | 'mobile.session.rename'
            | 'mobile.session.restore'
            | 'mobile.session.setPinned'
            | 'mobile.terminal.switchSurface';
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
 * Condenses a granted Session's Agent conversation into a reference file through Desktop's own handler, after the same
 * grant check Session management makes, so a phone can cite only Sessions it may see.
 */
export const prepareMobileSessionReference = async (
    domainService: ServerDomainService,
    principal: Principal,
    sessionId: string,
) => {
    await sessionForPrincipal(domainService, principal, sessionId);
    return domainService.request('session.conversationReference', { sessionId });
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
 * Rename with AI for a granted Session: the provider's suggestion, which the phone applies through Rename.
 */
export const suggestMobileSessionTitle = async (
    domainService: ServerDomainService,
    principal: Principal,
    sessionId: string,
): Promise<{ title: string }> => {
    await sessionForPrincipal(domainService, principal, sessionId);
    const { title } = await domainService.request('session.suggestTitle', { sessionId });
    return { title };
};

/**
 * Session management reuses Desktop's own handlers so rename, archive, restore, and pinning keep one implementation;
 * the gateway only adds the grant check in front of them. Restore lands at the top of the Project, matching Desktop's
 * dialog. Delete skips Desktop Main's native confirmation, which would open on the computer; the phone confirms first.
 * Reopening the Session's Agent on its other surface shares the same admission from the Session menu.
 */
export const applyMobileSessionManagement = async (
    domainService: ServerDomainService,
    principal: Principal,
    request: MobileSessionManagementRequest,
    signal: AbortSignal,
): Promise<{ sessionId: string } | { status: 'switched' | 'turnRunning' }> => {
    if (request.method === 'mobile.terminal.switchSurface')
        return switchMobileTerminalSurface(domainService, principal, request, signal);
    const { sessionId } = request.params;
    await sessionForPrincipal(domainService, principal, sessionId);
    switch (request.method) {
        case 'mobile.session.rename':
            await domainService.requestWithSignal(
                'session.rename',
                { sessionId, title: request.params.title },
                signal,
            );
            break;
        case 'mobile.session.archive':
            await domainService.requestWithSignal('session.archive', { sessionId }, signal);
            break;
        case 'mobile.session.delete':
            await domainService.requestWithSignal('session.delete', { sessionId }, signal);
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

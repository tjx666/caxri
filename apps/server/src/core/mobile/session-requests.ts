import type { CommandExecutionContext, Principal, ServerRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import type { createMobileAuthorityQueue } from './authority-queue';
import type { MobileSessionManagementRequest } from './session-management';
import {
    applyMobileSessionManagement,
    prepareMobileSessionReference,
    readMobileArchivedSessions,
    suggestMobileSessionTitle,
} from './session-management';
import { searchMobileSessions } from './session-search-requests';

type PairedPrincipal = Extract<Principal, { kind: 'paired-device' }>;

/**
 * Every phone Session method: create, the archived list, search, Rename with AI, the Chat `@` Session reference, and
 * the management writes.
 */
export type MobileSessionRequest =
    | MobileSessionManagementRequest
    | Extract<
          ServerRequest,
          {
              method:
                  | 'mobile.session.archived'
                  | 'mobile.session.conversationReference'
                  | 'mobile.session.create'
                  | 'mobile.session.search'
                  | 'mobile.session.suggestTitle';
          }
      >;

const mobileSessionMethods: ReadonlySet<string> = new Set<MobileSessionRequest['method']>([
    'mobile.session.archive',
    'mobile.session.archived',
    'mobile.session.conversationReference',
    'mobile.session.create',
    'mobile.session.delete',
    'mobile.session.rename',
    'mobile.session.restore',
    'mobile.session.search',
    'mobile.session.setPinned',
    'mobile.session.suggestTitle',
    'mobile.terminal.switchSurface',
]);

export const isMobileSessionRequest = (request: ServerRequest): request is MobileSessionRequest =>
    mobileSessionMethods.has(request.method);

/**
 * The access controller's grant checks, which this module applies without owning the device registry.
 */
export interface MobileSessionRequestAuthority {
    assertOpen: () => void;
    currentPairedPrincipal: (principal: Principal, method: string) => PairedPrincipal;
    runRevocableOperation: ReturnType<typeof createMobileAuthorityQueue>['runRevocableOperation'];
}

/**
 * Runs a phone Session method. Reads check the grant before and after; writes keep only admission in the authority
 * queue, since a Terminal launch or provider restart may outlive a revoke, which then withholds the result.
 */
export const invokeMobileSessionRequest = async (
    request: MobileSessionRequest,
    context: CommandExecutionContext,
    domainService: ServerDomainService,
    { assertOpen, currentPairedPrincipal, runRevocableOperation }: MobileSessionRequestAuthority,
): Promise<unknown> => {
    switch (request.method) {
        case 'mobile.session.create': {
            /**
             * A revoked client cannot receive a result after a durable create and must reconcile from dashboard when
             * paired again before retrying.
             */
            return runRevocableOperation(
                () => {
                    assertOpen();
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    if (!principal.projectIds.includes(request.params.projectId))
                        throw new CaxriError('NOT_FOUND', 'Project not found');
                    return principal;
                },
                (principal, signal) =>
                    domainService.requestWithSignal(
                        'mobile.session.createForPrincipal',
                        { ...request.params, principal },
                        signal,
                    ),
                (principal, signal) => {
                    if (signal.aborted)
                        throw new CaxriError('CANCELLED', 'Mobile Session creation was canceled');
                    currentPairedPrincipal(principal, request.method);
                },
            );
        }
        case 'mobile.session.archived': {
            const principal = currentPairedPrincipal(context.principal, request.method);
            const result = await readMobileArchivedSessions(domainService, principal);
            currentPairedPrincipal(principal, request.method);
            return result;
        }
        case 'mobile.session.conversationReference': {
            const principal = currentPairedPrincipal(context.principal, request.method);
            const result = await prepareMobileSessionReference(
                domainService,
                principal,
                request.params.sessionId,
            );
            currentPairedPrincipal(principal, request.method);
            return result;
        }
        case 'mobile.session.search': {
            const principal = currentPairedPrincipal(context.principal, request.method);
            const result = await searchMobileSessions(domainService, principal, request);
            currentPairedPrincipal(principal, request.method);
            return result;
        }
        case 'mobile.session.suggestTitle': {
            const principal = currentPairedPrincipal(context.principal, request.method);
            const result = await suggestMobileSessionTitle(
                domainService,
                principal,
                request.params.sessionId,
            );
            currentPairedPrincipal(principal, request.method);
            return result;
        }
        default: {
            return runRevocableOperation(
                () => {
                    assertOpen();
                    return currentPairedPrincipal(context.principal, request.method);
                },
                (principal, signal) =>
                    applyMobileSessionManagement(domainService, principal, request, signal),
                (principal) => currentPairedPrincipal(principal, request.method),
            );
        }
    }
};

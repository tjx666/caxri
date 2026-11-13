import type { Principal, ServerRequest } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { sessionForPrincipal } from './session-management';

type ChangesRequest = Extract<
    ServerRequest,
    { method: 'mobile.changes.list' | 'mobile.changes.diff' }
>;

/**
 * Lists a Session's changes or reads one file's diff after admitting the Session for this device; the internal Server
 * methods own the Git work and repeat the Project check against the principal.
 */
export async function invokeMobileChangesRequest(
    request: ChangesRequest,
    principal: Principal,
    domainService: ServerDomainService,
) {
    await sessionForPrincipal(domainService, principal, request.params.sessionId);
    return request.method === 'mobile.changes.list'
        ? domainService.request('mobile.changes.listInternal', {
              sessionId: request.params.sessionId,
              refresh: request.params.refresh,
              mode: request.params.mode,
              principal,
          })
        : domainService.request('mobile.changes.diffInternal', {
              sessionId: request.params.sessionId,
              repositoryId: request.params.repositoryId,
              path: request.params.path,
              mode: request.params.mode,
              principal,
          });
}

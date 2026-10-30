import type { Principal, ServerRequest } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { sessionForPrincipal } from './session-management';

type MobileUploadRequest = Extract<
    ServerRequest,
    { method: 'mobile.file.upload' | 'mobile.image.upload' }
>;

/**
 * Stores one uploaded image or file chunk for a Session the device may reach. The caller runs it in the authority
 * queue, and `assertCurrent` rejects the result when the device was revoked while the chunk was written.
 */
export async function invokeMobileUploadRequest(
    request: MobileUploadRequest,
    principal: Principal,
    domainService: ServerDomainService,
    assertCurrent: () => void,
) {
    await sessionForPrincipal(domainService, principal, request.params.sessionId);
    const result =
        request.method === 'mobile.image.upload'
            ? await domainService.request('mobile.image.uploadInternal', {
                  ...request.params,
                  principal,
              })
            : await domainService.request('mobile.file.uploadInternal', {
                  ...request.params,
                  principal,
              });
    assertCurrent();
    return result;
}

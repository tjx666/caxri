import type { MethodResult, Principal, ServerRequest } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { sessionForPrincipal } from './session-management';

type FileRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.files.list'
            | 'mobile.files.read'
            | 'mobile.files.write'
            | 'mobile.files.search';
    }
>;

/**
 * All four file operations share the same Project admission and final device-generation check.
 */
export async function invokeMobileFileRequest(
    request: FileRequest,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
    reauthorize: () => void,
) {
    await sessionForPrincipal(domainService, principal, request.params.sessionId);
    let result: MethodResult<FileRequest['method']>;
    switch (request.method) {
        case 'mobile.files.list':
            result = await domainService.request('mobile.files.listInternal', {
                sessionId: request.params.sessionId,
                directory: request.params.directory,
                principal,
            });
            break;
        case 'mobile.files.read':
            result = await domainService.request('mobile.files.readInternal', {
                sessionId: request.params.sessionId,
                path: request.params.path,
                principal,
            });
            break;
        case 'mobile.files.write':
            result = await domainService.request('mobile.files.writeInternal', {
                ...request.params,
                principal,
            });
            break;
        case 'mobile.files.search':
            result = await domainService.request('mobile.files.searchInternal', {
                ...request.params,
                principal,
            });
            break;
    }
    reauthorize();
    if (request.method === 'mobile.files.write')
        await sessionForPrincipal(domainService, principal, request.params.sessionId);
    return result;
}

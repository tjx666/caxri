import type { Principal, ServerRequest } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { sessionForPrincipal } from './session-management';

type AttentionRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.attention.list'
            | 'mobile.attention.answer'
            | 'mobile.attention.autoAllowRevoke';
    }
>;

export async function invokeMobileAttentionRequest(
    request: AttentionRequest,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
    reauthorize: () => void,
) {
    await sessionForPrincipal(domainService, principal, request.params.sessionId);
    const result = await (request.method === 'mobile.attention.list'
        ? domainService.request('mobile.attention.listInternal', { ...request.params, principal })
        : request.method === 'mobile.attention.answer'
          ? domainService.request('mobile.attention.answerInternal', {
                ...request.params,
                principal,
            })
          : domainService.request('mobile.attention.autoAllowRevokeInternal', {
                ...request.params,
                principal,
            }));
    reauthorize();
    return result;
}

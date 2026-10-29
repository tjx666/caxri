import type { MethodResult, Principal, ServerRequest } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { sessionForPrincipal } from './session-management';

type TimelineRequest = Extract<
    ServerRequest,
    { method: 'mobile.timeline.read' | 'mobile.timeline.readMessage' }
>;

/**
 * A Terminal Agent's timeline page and one of its messages read whole. Both admit the Session through the device's
 * Project grants first; the caller repeats the device-generation check once the read has finished.
 */
export async function invokeMobileTimelineRequest(
    request: TimelineRequest,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
): Promise<MethodResult<TimelineRequest['method']>> {
    await sessionForPrincipal(domainService, principal, request.params.sessionId);
    return request.method === 'mobile.timeline.read'
        ? domainService.request('mobile.timeline.readInternal', { ...request.params, principal })
        : domainService.request('mobile.timeline.readMessageInternal', {
              ...request.params,
              principal,
          });
}

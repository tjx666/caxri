import type { MobileCommanderInboxListResult, Principal, ServerRequest } from '@caxri/protocol';
import { projectCommanderInboxForMobile } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';

export type MobileCommanderInboxRequest = Extract<
    ServerRequest,
    { method: 'mobile.commanderInbox.list' | 'mobile.commanderInbox.reply' }
>;

/**
 * Serves the Commander Inbox to a paired device. The Inbox is the owner's, not one Project's, so `role-methods.ts`
 * admits only `control` devices, the role that already reaches beyond its granted Projects (`mobile.project.browse`).
 * The read returns only open items, shortened to one mobile frame; the reply is stored with source `mobile`.
 */
export async function invokeMobileCommanderInboxRequest(
    request: MobileCommanderInboxRequest,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
    reauthorize: () => unknown,
): Promise<MobileCommanderInboxListResult | { sequence: number }> {
    if (request.method === 'mobile.commanderInbox.list') {
        const inbox = await domainService.request('commander.inbox.list', {});
        reauthorize();
        return projectCommanderInboxForMobile(inbox);
    }
    const result = await domainService.request('mobile.commanderInbox.replyInternal', {
        ...request.params,
        principal,
    });
    reauthorize();
    return result;
}

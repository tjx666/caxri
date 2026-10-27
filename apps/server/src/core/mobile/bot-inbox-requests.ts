import type { MobileBotInboxListResult, Principal, ServerRequest } from '@caxri/protocol';
import { projectBotInboxForMobile } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';

export type MobileBotInboxRequest = Extract<
    ServerRequest,
    { method: 'mobile.botInbox.list' | 'mobile.botInbox.reply' }
>;

/**
 * Serves the Bot Inbox to a paired device. The Inbox is the owner's, not one Project's, so `role-methods.ts` admits
 * only `control` devices, the role that already reaches beyond its granted Projects (`mobile.project.browse`). The read
 * returns only open items, shortened to one mobile frame; the reply is stored with source `mobile`.
 */
export async function invokeMobileBotInboxRequest(
    request: MobileBotInboxRequest,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
    reauthorize: () => unknown,
): Promise<MobileBotInboxListResult | { sequence: number }> {
    if (request.method === 'mobile.botInbox.list') {
        const inbox = await domainService.request('bot.inbox.list', {});
        reauthorize();
        return projectBotInboxForMobile(inbox);
    }
    const result = await domainService.request('mobile.botInbox.replyInternal', {
        ...request.params,
        principal,
    });
    reauthorize();
    return result;
}

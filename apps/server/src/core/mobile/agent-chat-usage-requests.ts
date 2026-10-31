import type { AgentProvider, AgentUsageReadout } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import type { MobileAgentChatRequest, MobileOperationForwarder } from './agent-chat-requests';

type MobileAgentChatUsageRequest = Extract<
    MobileAgentChatRequest,
    {
        method:
            | 'mobile.agentChat.readUsage'
            | 'mobile.agentChat.dismissUsageNotice'
            | 'mobile.agentChat.usageLimitWait'
            | 'mobile.agentChat.generateHandoff'
            | 'mobile.agentChat.bypassUsageGuard';
    }
>;

/**
 * The phone's plan usage and its usage-limit and usage guard actions, on a Chat the access controller already resolved
 * through the device's granted Projects. Core owns the wait, the account's hand-off lease, and the guard, and refuses
 * an action that no longer applies (a wait already over, a lease another Chat took), so the phone forwards the Chat and
 * nothing else.
 */
export async function invokeMobileAgentChatUsageRequest(
    request: MobileAgentChatUsageRequest,
    terminal: { provider?: AgentProvider | undefined },
    {
        domainService,
        forward,
        reauthorize,
    }: {
        domainService: ServerDomainService;
        forward: MobileOperationForwarder;
        reauthorize: () => unknown;
    },
): Promise<AgentUsageReadout | null> {
    const { terminalId } = request.params;
    switch (request.method) {
        case 'mobile.agentChat.readUsage': {
            const readout = await domainService.request('terminal.agentUsage', { terminalId });
            reauthorize();
            return readout;
        }
        case 'mobile.agentChat.dismissUsageNotice': {
            if (!terminal.provider)
                throw new CaxriError('CONFLICT', 'This Chat has no Agent provider yet');
            await forward({
                method: 'usage.dismissNotice',
                params: { provider: terminal.provider, notice: request.params.notice },
            });
            return null;
        }
        case 'mobile.agentChat.usageLimitWait': {
            const { turnId, action } = request.params;
            await forward({
                method: 'agentChat.usageLimitWait',
                params: { terminalId, turnId, action },
            });
            return null;
        }
        case 'mobile.agentChat.generateHandoff':
        case 'mobile.agentChat.bypassUsageGuard': {
            await forward({
                method:
                    request.method === 'mobile.agentChat.generateHandoff'
                        ? 'agentChat.generateHandoff'
                        : 'agentChat.bypassUsageGuard',
                params: { terminalId },
            });
            return null;
        }
    }
}

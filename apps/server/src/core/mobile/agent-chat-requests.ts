import type {
    AgentChatSnapshot,
    Principal,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import { CaxriError, windowAgentChatSnapshotForMobile } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { terminalForPrincipal } from './action-requests';

export type MobileAgentChatRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.agentChat.read'
            | 'mobile.agentChat.send'
            | 'mobile.agentChat.interrupt'
            | 'mobile.agentChat.respond'
            | 'mobile.agentChat.retry';
    }
>;

/**
 * Forwards a Server operation through Core's mutation admission, the same path a Desktop request takes.
 */
export type MobileOperationForwarder = (request: ServerOperationRequest) => Promise<unknown>;

/**
 * Resolves a Terminal through the device's granted Projects and accepts only a Chat, so a phone can never reach a PTY
 * through the Chat methods or subscription.
 */
export async function agentChatTerminalForPrincipal(
    domainService: ServerDomainService,
    principal: Principal,
    terminalId: string,
) {
    const terminal = await terminalForPrincipal(domainService, principal, terminalId);
    if (terminal.surface !== 'chat')
        throw new CaxriError('CONFLICT', 'This Terminal is not an Agent Chat');
    return terminal;
}

/**
 * Drives one Agent Chat for a paired device. The Terminal is resolved through the device's granted Projects first, and
 * only a Chat Terminal is accepted, so a phone can never reach a PTY through these methods.
 */
export async function invokeMobileAgentChatRequest(
    request: MobileAgentChatRequest,
    principal: Extract<Principal, { kind: 'paired-device' }>,
    domainService: ServerDomainService,
    forwardOperation: MobileOperationForwarder | undefined,
    reauthorize: () => unknown,
): Promise<AgentChatSnapshot | null> {
    if (!forwardOperation)
        throw new CaxriError('UNAVAILABLE', 'Agent Chat is unavailable to paired devices');
    const forward = forwardOperation;
    const { terminalId } = request.params;
    await agentChatTerminalForPrincipal(domainService, principal, terminalId);
    reauthorize();
    switch (request.method) {
        case 'mobile.agentChat.read': {
            const snapshot = await domainService.request('agentChat.read', { terminalId });
            reauthorize();
            return windowAgentChatSnapshotForMobile(snapshot);
        }
        case 'mobile.agentChat.send': {
            /**
             * Paired devices do not see Desktop's message queue, so a message sent during a turn steers it, as it did
             * before the queue existed, instead of waiting somewhere the sender cannot see.
             */
            await forward({
                method: 'agentChat.send',
                params: { terminalId, text: request.params.text, delivery: 'steer' },
            });
            return null;
        }
        case 'mobile.agentChat.interrupt': {
            await forward({ method: 'agentChat.interrupt', params: { terminalId } });
            return null;
        }
        case 'mobile.agentChat.respond': {
            await forward({
                method: 'agentChat.respond',
                params: {
                    terminalId,
                    requestId: request.params.requestId,
                    response: request.params.response,
                },
            });
            return null;
        }
        case 'mobile.agentChat.retry': {
            /**
             * Mirrors the Desktop pane: only a failed provider is restarted (which clears the failure and resumes the
             * bound conversation); otherwise a read is enough, and restarting would cut off a running turn.
             */
            const snapshot = await domainService.request('agentChat.read', { terminalId });
            if (snapshot.status === 'failed')
                await forward({
                    method: 'terminal.restart',
                    params: { terminalId, mode: 'resume' },
                });
            return null;
        }
    }
}

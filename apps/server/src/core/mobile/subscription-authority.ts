import type { MobileSubscriptionResource } from '@caxri/mobile-transport';
import type { Principal, ServerEvent } from '@caxri/protocol';
import { assertNever } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { terminalForPrincipal } from './action-requests';
import { agentChatTerminalForPrincipal } from './agent-chat-requests';
import { sessionForPrincipal } from './session-management';

type PairedPrincipal = Extract<Principal, { kind: 'paired-device' }>;

/**
 * The read method whose role grant a subscription to `resource` requires.
 */
export const mobileSubscriptionMethod = (resource: MobileSubscriptionResource): string => {
    switch (resource.kind) {
        case 'terminal': {
            return 'terminal.preview';
        }
        case 'agentChat': {
            return 'mobile.agentChat.read';
        }
        default: {
            return 'mobile.dashboard';
        }
    }
};

/**
 * Resolves the subscribed entity through the device's current Project grant, so a subscription never outlives access to
 * what it watches.
 */
export async function authorizeMobileSubscriptionResource(
    domainService: ServerDomainService,
    principal: PairedPrincipal,
    resource: MobileSubscriptionResource,
): Promise<void> {
    switch (resource.kind) {
        case 'terminal': {
            await terminalForPrincipal(domainService, principal, resource.terminalId);
            return;
        }
        case 'agentChat': {
            await agentChatTerminalForPrincipal(domainService, principal, resource.terminalId);
            return;
        }
        case 'conversation':
        case 'changes': {
            await sessionForPrincipal(domainService, principal, resource.sessionId);
            return;
        }
        case 'dashboard': {
            return;
        }
        default: {
            assertNever(resource, 'Unhandled mobile subscription authority');
        }
    }
}

/**
 * Whether an authorized subscription to `resource` receives `event`.
 */
export async function isMobileSubscriptionEvent(
    domainService: ServerDomainService,
    principal: Principal,
    resource: MobileSubscriptionResource,
    event: ServerEvent,
): Promise<boolean> {
    switch (resource.kind) {
        case 'dashboard':
            return event.event === 'state.changed';
        case 'terminal':
            return (
                event.event === 'terminal.output' &&
                event.payload.terminalId === resource.terminalId
            );
        case 'agentChat':
            return (
                event.event === 'agentChat.patch' &&
                event.payload.terminalId === resource.terminalId
            );
        case 'changes':
            return (
                event.event === 'git.changed' &&
                event.payload.sessionIds.includes(resource.sessionId)
            );
        case 'conversation': {
            if (event.event !== 'agentTranscript.changed') return false;
            const terminal = await terminalForPrincipal(
                domainService,
                principal,
                event.payload.terminalId,
            );
            return terminal.sessionId === resource.sessionId;
        }
        default:
            return assertNever(resource, 'Unhandled mobile subscription event');
    }
}

import type {
    AgentEndpointRef,
    CommandAdapter,
    CommandExecutionContext,
    Principal,
    ServerEvent,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';

import type { TerminalExecutionPort } from '../../domains/terminal';
import type { AgentEndpointRegistry } from '../agent-endpoints/registry';
import type { ServerDomainService } from '../domain-service';
import type { ExtensionService } from '../extensions/service';

export function resolveMobileAgentEndpoint(
    registry: AgentEndpointRegistry,
    terminalId: string,
): AgentEndpointRef | undefined {
    try {
        return registry.resolveTerminal(terminalId).ref;
    } catch {
        return undefined;
    }
}

export type MobileControlRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.access.disable'
            | 'mobile.access.enable'
            | 'mobile.access.status'
            | 'mobile.device.list'
            | 'mobile.dashboard'
            | 'mobile.session.show'
            | 'mobile.timeline.read'
            | 'mobile.changes.list'
            | 'mobile.changes.diff'
            | 'mobile.agent.availability'
            | 'mobile.agent.actions'
            | 'mobile.attention.list'
            | 'mobile.attention.answer'
            | 'mobile.attention.autoAllowRevoke'
            | 'mobile.agent.submit'
            | 'mobile.image.upload'
            | 'mobile.session.create'
            | 'mobile.session.rename'
            | 'mobile.session.archive'
            | 'mobile.session.restore'
            | 'mobile.session.archived'
            | 'mobile.terminal.takeOver'
            | 'mobile.terminal.release'
            | 'mobile.terminal.input'
            | 'mobile.terminal.scroll'
            | 'mobile.agentChat.read'
            | 'mobile.agentChat.readImage'
            | 'mobile.agentChat.send'
            | 'mobile.agentChat.interrupt'
            | 'mobile.agentChat.respond'
            | 'mobile.agentChat.retry'
            | 'mobile.agentChat.configure'
            | 'mobile.commanderInbox.list'
            | 'mobile.commanderInbox.reply'
            | 'mobile.pairing.create'
            | 'mobile.project.browse'
            | 'mobile.project.add'
            | 'mobile.panels.list'
            | 'mobile.tree.children'
            | 'mobile.files.list'
            | 'mobile.files.read'
            | 'mobile.files.search'
            | 'mobile.files.write'
            | 'mobile.update.check'
            | 'mobile.update.prepare';
    }
>;
type MobileDesktopOperation = Extract<
    ServerOperationRequest,
    { method: 'mobile.device.revoke.apply' }
>;

export const isMobileControlRequest = (request: ServerRequest): request is MobileControlRequest =>
    request.method.startsWith('mobile.');

export interface MobileAccessController {
    attach: (
        adapter: CommandAdapter,
        bootId: string,
        protocolIdentity: { serverId: string; stateEpoch: string },
        domainService: ServerDomainService,
        terminalExecution: TerminalExecutionPort,
        getExtensionService: () => ExtensionService | undefined,
    ) => void;
    close: () => Promise<void>;
    publish: (event: ServerEvent) => void;
    invokeControl: (
        request: MobileControlRequest,
        context: CommandExecutionContext,
        domainService: ServerDomainService,
        resolveAgentEndpoint?: (terminalId: string) => AgentEndpointRef | undefined,
        /**
         * Core's admission-checked forwarder for mutations a paired device triggers on a Server domain, such as Agent
         * Chat sends and restarts. Omitted only by callers that never route those methods.
         */
        forwardOperation?: (request: ServerOperationRequest) => Promise<unknown>,
    ) => Promise<unknown>;
    invokeDesktopOperation: (request: MobileDesktopOperation) => Promise<unknown>;
    authorizePairedDeviceMethod: (principal: Principal, method: string) => void;
    hasAttentionRecipient: (projectId: string) => boolean;
    validatePairedDeviceRequest: (
        request:
            | Extract<ServerRequest, { method: 'session.markRead' }>
            | Extract<ServerRequest, { method: 'terminal.preview' }>,
        context: CommandExecutionContext,
        domainService: ServerDomainService,
    ) => Promise<void>;
}

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
            | 'mobile.timeline.readMessage'
            | 'mobile.changes.list'
            | 'mobile.changes.diff'
            | 'mobile.agent.availability'
            | 'mobile.agent.actions'
            | 'mobile.attention.list'
            | 'mobile.attention.answer'
            | 'mobile.attention.autoAllowRevoke'
            | 'mobile.agent.submit'
            | 'mobile.image.upload'
            | 'mobile.file.upload'
            | 'mobile.session.create'
            | 'mobile.session.rename'
            | 'mobile.session.archive'
            | 'mobile.session.restore'
            | 'mobile.session.setPinned'
            | 'mobile.session.delete'
            | 'mobile.session.suggestTitle'
            | 'mobile.session.menuState'
            | 'mobile.session.restartAgent'
            | 'mobile.session.detach'
            | 'mobile.session.resume'
            | 'mobile.session.reopenConversation'
            | 'mobile.session.handOverToBot'
            | 'mobile.session.takeBackFromBot'
            | 'mobile.session.conversationReference'
            | 'mobile.session.archived'
            | 'mobile.session.search'
            | 'mobile.terminal.takeOver'
            | 'mobile.terminal.release'
            | 'mobile.terminal.input'
            | 'mobile.terminal.scroll'
            | 'mobile.terminal.switchSurface'
            | 'mobile.agentChat.read'
            | 'mobile.agentChat.requests'
            | 'mobile.agentChat.readImage'
            | 'mobile.agentChat.readTask'
            | 'mobile.agentChat.readHistory'
            | 'mobile.agentChat.readUsage'
            | 'mobile.agentChat.dismissUsageNotice'
            | 'mobile.agentChat.usageLimitWait'
            | 'mobile.agentChat.generateHandoff'
            | 'mobile.agentChat.bypassUsageGuard'
            | 'mobile.agentChat.readMessage'
            | 'mobile.agentChat.send'
            | 'mobile.agentChat.interrupt'
            | 'mobile.agentChat.stopTask'
            | 'mobile.agentChat.implementPlan'
            | 'mobile.agentChat.respond'
            | 'mobile.agentChat.retry'
            | 'mobile.agentChat.configure'
            | 'mobile.agentChat.removeQueued'
            | 'mobile.agentChat.sendQueuedNow'
            | 'mobile.agentChat.resumeQueue'
            | 'mobile.agentChat.takeQueued'
            | 'mobile.agentChat.readQueued'
            | 'mobile.agentChat.editQueued'
            | 'mobile.agentChat.rewind'
            | 'mobile.agentChat.fork'
            | 'mobile.agentChat.continuationTargets'
            | 'mobile.agentChat.continueInAgent'
            | 'mobile.agentChat.runCommand'
            | 'mobile.botInbox.list'
            | 'mobile.botInbox.reply'
            | 'mobile.host.status'
            | 'mobile.desktopUpdate.read'
            | 'mobile.desktopUpdate.download'
            | 'mobile.desktopUpdate.install'
            | 'mobile.preview.list'
            | 'mobile.preview.open'
            | 'mobile.video.read'
            | 'mobile.video.open'
            | 'mobile.pairing.create'
            | 'mobile.project.browse'
            | 'mobile.project.add'
            | 'mobile.project.reorder'
            | 'mobile.panels.list'
            | 'mobile.agentUsage.read'
            | 'mobile.pullRequest.read'
            | 'mobile.pullRequest.merge'
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
    watchesExtensionViews: (sessionId: string) => boolean;
    validatePairedDeviceRequest: (
        request:
            | Extract<ServerRequest, { method: 'session.markRead' }>
            | Extract<ServerRequest, { method: 'terminal.preview' }>,
        context: CommandExecutionContext,
        domainService: ServerDomainService,
    ) => Promise<void>;
}

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import type { MobileSubscriptionResource } from '@caxri/mobile-transport';
import type { Principal } from '@caxri/protocol';
import { assertNever, CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { MobileDeviceStore } from '../../domains/db';
import type { ServerDomainService } from '../domain-service';
import type { ExtensionService } from '../extensions/service';
import type { MobileAccessController } from './access-controller-contract';
import { createMobileAccessPersistence } from './access-persistence';
import { listMobileAgentActions, terminalForPrincipal } from './action-requests';
import {
    agentChatTerminalProjectRoot,
    beginMobileAgentChatWatch,
    invokeMobileAgentChatRequest,
    isMobileAgentChatRead,
    isMobileAgentChatRequest,
} from './agent-chat-requests';
import { createMobileAgentUsageRequests } from './agent-usage-requests';
import { invokeMobileAttentionRequest } from './attention-requests';
import { createMobileAuthorityQueue } from './authority-queue';
import { invokeMobileBotInboxRequest } from './bot-inbox-requests';
import { readMobileDashboard, showMobileSession } from './dashboard-requests';
import { MobileDeviceRegistry } from './device-registry';
import { invokeMobileFileRequest } from './file-requests';
import { MobileGateway } from './gateway';
import { adoptCurrentPairedPrincipal } from './gateway/principal-grant';
import { mobileHostDisplayName } from './host-display-name';
import { createMobileHostStatusReader } from './host-status';
import { invokeMobilePanelRequest } from './panel-requests';
import { createMobilePreviewRequests } from './preview';
import { createMobilePairing, invokeMobileProjectRequest } from './project-requests';
import { mergeMobilePullRequest, readMobilePullRequest } from './pull-request-requests';
import { createRelaySettingFollower } from './relay';
import { isMobileGatewayMethodAllowedForRole } from './role-methods';
import { sessionForPrincipal } from './session-management';
import { invokeMobileSessionRequest, isMobileSessionRequest } from './session-requests';
import {
    authorizeMobileSubscriptionResource,
    isMobileSubscriptionEvent,
    mobileSubscriptionMethod,
} from './subscription-authority';
import { invokeMobileTerminalRequest } from './terminal-requests';
import { invokeMobileTimelineRequest } from './timeline-requests';
import { createMobileUpdateRequests } from './update-bundle';

const requiredGateway = (gateway: MobileGateway | undefined): MobileGateway => {
    if (!gateway) throw new CaxriError('UNAVAILABLE', 'Mobile access is unavailable');
    return gateway;
};

/**
 * Owns the default-off LAN listener and keeps paired-device authorization out of the general Server dispatcher.
 */
export const openMobileAccessController = (options: {
    logger?: Pick<StructuredLogger, 'write'>;
    hostDisplayName?: string;
    /**
     * Forwarded to `MobileGateway`; lets a caller fold the authenticated Mobile connection count into a broader
     * idle-exit or diagnostics signal alongside `ControlServer`'s own client count.
     */
    onConnectionCountChanged?: (count: number) => void;
    selectAddress?: () => string;
    store: MobileDeviceStore;
    /**
     * Directory holding the Android update bundle shipped with this Desktop build, when there is one.
     */
    updateDirectory?: string;
}): MobileAccessController => {
    const registry = MobileDeviceRegistry.open({ store: options.store });
    let gateway: MobileGateway | undefined;
    let getExtensionService: (() => ExtensionService | undefined) | undefined;
    const hostDisplayName = mobileHostDisplayName(options.hostDisplayName ?? hostname());
    const updateRequests = createMobileUpdateRequests(options.updateDirectory);
    const readAgentUsage = createMobileAgentUsageRequests({
        ...(options.logger && { logger: options.logger }),
    });
    const accessPersistence = createMobileAccessPersistence(registry, options.logger);
    const previews = createMobilePreviewRequests({
        logger: options.logger,
        random: randomBytes,
        registry,
    });
    const readHostStatus = createMobileHostStatusReader(options.logger);
    let isClosed = false;
    let applyRelaySetting: (() => void) | undefined;
    const assertOpen = (): void => {
        if (isClosed) throw new CaxriError('UNAVAILABLE', 'Mobile access is shutting down');
    };
    const { abortOperations, runRevocableOperation, withAuthority } = createMobileAuthorityQueue();
    const currentPairedPrincipal = (principal: Principal, method: string) => {
        if (principal.kind !== 'paired-device')
            throw new CaxriError('FORBIDDEN', 'Paired device principal is required');
        const current = adoptCurrentPairedPrincipal(
            principal,
            registry.currentPrincipal(principal.deviceId, principal.generation),
        );
        if (!current) throw new CaxriError('FORBIDDEN', 'Paired device authorization changed');
        if (!isMobileGatewayMethodAllowedForRole(current.role, method))
            throw new CaxriError('FORBIDDEN', 'Paired device role does not allow this method');
        return current;
    };
    const authorizeSubscription = (
        principal: Principal,
        resource: MobileSubscriptionResource,
        domainService: ServerDomainService,
    ): Promise<void> =>
        authorizeMobileSubscriptionResource(
            domainService,
            currentPairedPrincipal(principal, mobileSubscriptionMethod(resource)),
            resource,
        );
    return {
        authorizePairedDeviceMethod: (principal, method) => {
            currentPairedPrincipal(principal, method);
        },
        attach: (
            adapter,
            bootId,
            protocolIdentity,
            domainService,
            terminalExecution,
            resolveExtensionService,
        ) => {
            assertOpen();
            getExtensionService = resolveExtensionService;
            gateway = new MobileGateway({
                logger: options.logger,
                adapters: { server: adapter },
                bootId,
                ...(options.onConnectionCountChanged && {
                    onConnectionCountChanged: options.onConnectionCountChanged,
                }),
                protocolIdentity,
                registry,
                terminalExecution,
                authorizePairedDeviceMethod: (principal, method) => {
                    currentPairedPrincipal(principal, method);
                },
                authorizeSubscription: (principal, resource) =>
                    authorizeSubscription(principal, resource, domainService),
                agentChatProjectRoot: (principal, terminalId) =>
                    agentChatTerminalProjectRoot(
                        domainService,
                        currentPairedPrincipal(principal, 'mobile.agentChat.read'),
                        terminalId,
                    ),
                beginAgentChatSubscription: (principal, terminalId) =>
                    beginMobileAgentChatWatch(
                        domainService,
                        currentPairedPrincipal(principal, 'mobile.agentChat.read'),
                        terminalId,
                    ),
                beginConversationSubscription: async (principal, sessionId) => {
                    const current = currentPairedPrincipal(principal, 'mobile.timeline.read');
                    await sessionForPrincipal(domainService, current, sessionId);
                    const watched = await domainService.request('mobile.timeline.watchInternal', {
                        sessionId,
                        principal: current,
                    });
                    const close = () => {
                        if (!watched.terminalId) return;
                        void domainService
                            .request('mobile.timeline.unwatchInternal', {
                                terminalId: watched.terminalId,
                            })
                            .catch(() => {});
                    };
                    try {
                        currentPairedPrincipal(current, 'mobile.timeline.read');
                    } catch (error) {
                        close();
                        throw error;
                    }
                    return close;
                },
                matchesSubscriptionEvent: async (principal, resource, event) => {
                    await authorizeSubscription(principal, resource, domainService);
                    return isMobileSubscriptionEvent(domainService, principal, resource, event);
                },
                ...(options.selectAddress && { selectAddress: options.selectAddress }),
                updateSource: updateRequests.readSource,
            });
            applyRelaySetting = createRelaySettingFollower(gateway, domainService);
            applyRelaySetting();
            void withAuthority(() => accessPersistence.restore(isClosed ? undefined : gateway));
        },
        close: () =>
            withAuthority(async () => {
                isClosed = true;
                abortOperations();
                await Promise.all([gateway?.close(), previews.clear()]);
            }),
        publish: (event) => {
            if (event.event === 'settings.changed') applyRelaySetting?.();
            gateway?.publish(event);
        },
        invokeControl: async (
            request,
            context,
            domainService,
            resolveAgentEndpoint,
            forwardOperation,
        ) => {
            /**
             * Chat mutations take the same authority order as an attention answer, so a revoke that lands first always
             * wins; a read needs no serialization. Every `mobile.agentChat.*` method routes here, and
             * `invokeMobileAgentChatRequest` switches over them exhaustively.
             */
            if (isMobileAgentChatRequest(request)) {
                requiredGateway(gateway);
                const invoke = async () => {
                    assertOpen();
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    return invokeMobileAgentChatRequest(
                        request,
                        principal,
                        domainService,
                        forwardOperation,
                        () => currentPairedPrincipal(principal, request.method),
                    );
                };
                return isMobileAgentChatRead(request) ? invoke() : withAuthority(invoke);
            }
            if (isMobileSessionRequest(request)) {
                requiredGateway(gateway);
                return invokeMobileSessionRequest(request, context, domainService, {
                    assertOpen,
                    currentPairedPrincipal,
                    runRevocableOperation,
                });
            }
            const activeGateway = requiredGateway(gateway);
            switch (request.method) {
                case 'mobile.access.status':
                    return activeGateway.status();
                case 'mobile.access.enable':
                    return withAuthority(() => {
                        assertOpen();
                        return accessPersistence.apply(activeGateway, true);
                    });
                case 'mobile.access.disable':
                    return withAuthority(() => {
                        assertOpen();
                        abortOperations();
                        void previews.clear();
                        return accessPersistence.apply(activeGateway, false);
                    });
                case 'mobile.device.list':
                    return { devices: registry.list() };
                case 'mobile.dashboard': {
                    const paired =
                        context.principal.kind === 'paired-device'
                            ? currentPairedPrincipal(context.principal, request.method)
                            : undefined;
                    return readMobileDashboard(domainService, context.principal, {
                        hostDisplayName,
                        deviceRole: paired?.role ?? null,
                        resolveAgentEndpoint,
                    });
                }
                case 'mobile.session.show': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    return showMobileSession(
                        domainService,
                        principal,
                        request.params.sessionId,
                        { hostDisplayName, deviceRole: principal.role, resolveAgentEndpoint },
                        () => currentPairedPrincipal(principal, request.method),
                    );
                }
                case 'mobile.timeline.read':
                case 'mobile.timeline.readMessage': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    const result = await invokeMobileTimelineRequest(
                        request,
                        principal,
                        domainService,
                    );
                    currentPairedPrincipal(principal, request.method);
                    return result;
                }
                case 'mobile.changes.list':
                case 'mobile.changes.diff': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    await sessionForPrincipal(domainService, principal, request.params.sessionId);
                    const result =
                        request.method === 'mobile.changes.list'
                            ? await domainService.request('mobile.changes.listInternal', {
                                  sessionId: request.params.sessionId,
                                  refresh: request.params.refresh,
                                  principal,
                              })
                            : await domainService.request('mobile.changes.diffInternal', {
                                  sessionId: request.params.sessionId,
                                  repositoryId: request.params.repositoryId,
                                  path: request.params.path,
                                  principal,
                              });
                    currentPairedPrincipal(principal, request.method);
                    return result;
                }
                case 'mobile.agent.availability': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    const result = await domainService.request(
                        'mobile.agent.availabilityInternal',
                        {
                            projectId: request.params.projectId,
                            principal,
                        },
                    );
                    currentPairedPrincipal(principal, request.method);
                    return result;
                }
                case 'mobile.agent.actions': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    return listMobileAgentActions(request, principal, domainService, () => {
                        currentPairedPrincipal(principal, request.method);
                    });
                }
                case 'mobile.attention.list': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    return invokeMobileAttentionRequest(request, principal, domainService, () => {
                        currentPairedPrincipal(principal, request.method);
                    });
                }
                /**
                 * Both are a one-shot control command with revocation: an Agent permission decision, or the "Always
                 * allow in this Session" revoke sharing the same grant path (issue caxri#1295).
                 */
                case 'mobile.attention.answer':
                case 'mobile.attention.autoAllowRevoke': {
                    return withAuthority(async () => {
                        assertOpen();
                        const principal = currentPairedPrincipal(context.principal, request.method);
                        return invokeMobileAttentionRequest(
                            request,
                            principal,
                            domainService,
                            () => {
                                currentPairedPrincipal(principal, request.method);
                            },
                        );
                    });
                }
                case 'mobile.agent.submit': {
                    return runRevocableOperation(
                        () => {
                            assertOpen();
                            if (!activeGateway.status().enabled)
                                throw new CaxriError('FORBIDDEN', 'Mobile access is disabled');
                            return currentPairedPrincipal(context.principal, request.method);
                        },
                        (principal, signal) =>
                            domainService.requestWithSignal(
                                'mobile.agent.submitInternal',
                                { ...request.params, principal },
                                signal,
                            ),
                        (principal, signal) => {
                            if (signal.aborted)
                                throw new CaxriError('CANCELLED', 'Mobile submission was canceled');
                            currentPairedPrincipal(principal, request.method);
                        },
                    );
                }
                case 'mobile.image.upload': {
                    return withAuthority(async () => {
                        assertOpen();
                        const principal = currentPairedPrincipal(context.principal, request.method);
                        await sessionForPrincipal(
                            domainService,
                            principal,
                            request.params.sessionId,
                        );
                        const result = await domainService.request('mobile.image.uploadInternal', {
                            ...request.params,
                            principal,
                        });
                        currentPairedPrincipal(principal, request.method);
                        return result;
                    });
                }
                case 'mobile.agentUsage.read': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    const result = await readAgentUsage(domainService, principal);
                    currentPairedPrincipal(principal, request.method);
                    return result;
                }
                case 'mobile.pullRequest.read': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    const result = await readMobilePullRequest(domainService, principal, request);
                    currentPairedPrincipal(principal, request.method);
                    return result;
                }
                case 'mobile.pullRequest.merge': {
                    return runRevocableOperation(
                        () => {
                            assertOpen();
                            return currentPairedPrincipal(context.principal, request.method);
                        },
                        (principal, signal) =>
                            mergeMobilePullRequest(domainService, principal, request, signal),
                        (principal) => currentPairedPrincipal(principal, request.method),
                    );
                }
                case 'mobile.terminal.takeOver':
                case 'mobile.terminal.release':
                case 'mobile.terminal.input':
                case 'mobile.terminal.scroll': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    await terminalForPrincipal(domainService, principal, request.params.terminalId);
                    const current = currentPairedPrincipal(principal, request.method);
                    await terminalForPrincipal(domainService, current, request.params.terminalId);
                    const observer = activeGateway.terminalSubscription(
                        context,
                        request.params.subscriptionId,
                        request.params.terminalId,
                    );
                    return invokeMobileTerminalRequest(request, observer);
                }
                case 'mobile.pairing.create': {
                    return withAuthority(() => {
                        assertOpen();
                        return createMobilePairing(
                            domainService,
                            context.principal,
                            request,
                            (ids) => activeGateway.createPairing(ids),
                        );
                    });
                }
                case 'mobile.project.browse':
                case 'mobile.project.add': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    return invokeMobileProjectRequest(
                        request,
                        principal,
                        domainService,
                        registry,
                        () => currentPairedPrincipal(principal, request.method),
                    );
                }
                /**
                 * A reply takes the same authority order as an attention answer, so a revoke that lands first wins.
                 */
                case 'mobile.botInbox.list':
                case 'mobile.botInbox.reply': {
                    const invoke = () => {
                        assertOpen();
                        const principal = currentPairedPrincipal(context.principal, request.method);
                        return invokeMobileBotInboxRequest(request, principal, domainService, () =>
                            currentPairedPrincipal(principal, request.method),
                        );
                    };
                    return request.method === 'mobile.botInbox.list'
                        ? invoke()
                        : withAuthority(invoke);
                }
                case 'mobile.host.status': {
                    assertOpen();
                    currentPairedPrincipal(context.principal, request.method);
                    const status = await readHostStatus(domainService);
                    currentPairedPrincipal(context.principal, request.method);
                    return status;
                }
                case 'mobile.files.write': {
                    /**
                     * Keep the bounded atomic save inside the same authority order as device revocation.
                     */
                    return withAuthority(async () => {
                        assertOpen();
                        const principal = currentPairedPrincipal(context.principal, request.method);
                        return invokeMobileFileRequest(request, principal, domainService, () => {
                            currentPairedPrincipal(principal, request.method);
                        });
                    });
                }
                case 'mobile.preview.list':
                case 'mobile.preview.open': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    return previews.invoke(
                        request,
                        principal,
                        domainService,
                        () => activeGateway.connectionAddress(context),
                        () => currentPairedPrincipal(principal, request.method),
                    );
                }
                case 'mobile.files.list':
                case 'mobile.files.read':
                case 'mobile.files.search': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    return invokeMobileFileRequest(request, principal, domainService, () => {
                        currentPairedPrincipal(principal, request.method);
                    });
                }
                case 'mobile.update.check':
                case 'mobile.update.prepare': {
                    currentPairedPrincipal(context.principal, request.method);
                    return updateRequests.invoke(request, (source) =>
                        activeGateway.prepareUpdateDownload(context, source),
                    );
                }
                case 'mobile.panels.list':
                case 'mobile.tree.children': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    return invokeMobilePanelRequest(
                        request,
                        principal,
                        domainService,
                        getExtensionService?.(),
                        () => currentPairedPrincipal(principal, request.method),
                    );
                }
                default:
                    return assertNever(request, 'Mobile control method is not implemented');
            }
        },
        invokeDesktopOperation: (request) =>
            withAuthority(async () => {
                assertOpen();
                const { deviceId, expectedGeneration } = request.params;
                const revocation = requiredGateway(gateway).revoke(deviceId, expectedGeneration);
                abortOperations({ deviceId, generation: expectedGeneration });
                return revocation;
            }),
        hasAttentionRecipient: (projectId) => gateway?.hasAttentionRecipient(projectId) ?? false,
        watchesExtensionViews: (sessionId) => gateway?.watchesExtensionViews(sessionId) ?? false,
        validatePairedDeviceRequest: async (request, context, domainService) => {
            currentPairedPrincipal(context.principal, request.method);
            if (request.method === 'terminal.preview') {
                await terminalForPrincipal(
                    domainService,
                    context.principal,
                    request.params.terminalId,
                );
                return;
            }
            await sessionForPrincipal(domainService, context.principal, request.params.sessionId);
        },
    };
};

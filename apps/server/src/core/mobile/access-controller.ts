import { hostname } from 'node:os';

import type { MobileSubscriptionResource } from '@caxri/mobile-transport';
import type {
    AgentEndpointRef,
    CommandAdapter,
    CommandExecutionContext,
    MobileDeviceRole,
    Principal,
    ServerEvent,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { TerminalExecutionPort } from '../../domains/terminal';
import type { AgentEndpointRegistry } from '../agent-endpoints/registry';
import type { ServerDomainService } from '../domain-service';
import { buildMobileDashboard } from './dashboard';
import { MobileDeviceRegistry } from './device-registry';
import { MobileGateway } from './gateway';

const mobileGatewayMethodsByRole = {
    view: [
        'mobile.dashboard',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'terminal.preview',
    ],
    reply: [
        'mobile.dashboard',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'terminal.preview',
        'session.markRead',
        'mobile.agent.submit',
    ],
    control: [
        'mobile.dashboard',
        'mobile.session.show',
        'mobile.timeline.read',
        'mobile.changes.list',
        'mobile.changes.diff',
        'mobile.agent.availability',
        'terminal.preview',
        'session.markRead',
        'mobile.agent.submit',
        'agent.control.interrupt',
        'mobile.session.create',
        'mobile.terminal.takeOver',
        'mobile.terminal.release',
        'mobile.terminal.input',
    ],
} as const satisfies Record<MobileDeviceRole, readonly string[]>;

export const isMobileGatewayMethodAllowedForRole = (
    role: MobileDeviceRole,
    method: string,
): boolean => (mobileGatewayMethodsByRole[role] as readonly string[]).includes(method);

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

export const mobileHostDisplayName = (source: string): string =>
    source
        .split('.', 1)[0]
        .replaceAll(/[^\p{L}\p{N} _-]/gu, '')
        .trim()
        .slice(0, 100) || 'Caxri Host';
type MobileControlRequest = Extract<
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
            | 'mobile.agent.submit'
            | 'mobile.session.create'
            | 'mobile.terminal.takeOver'
            | 'mobile.terminal.release'
            | 'mobile.terminal.input'
            | 'mobile.pairing.create';
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
    ) => void;
    close: () => Promise<void>;
    publish: (event: ServerEvent) => void;
    invokeControl: (
        request: MobileControlRequest,
        context: CommandExecutionContext,
        domainService: ServerDomainService,
        resolveAgentEndpoint?: (terminalId: string) => AgentEndpointRef | undefined,
    ) => Promise<unknown>;
    invokeDesktopOperation: (request: MobileDesktopOperation) => Promise<unknown>;
    authorizePairedDeviceMethod: (principal: Principal, method: string) => void;
    validatePairedDeviceRequest: (
        request:
            | Extract<ServerRequest, { method: 'session.markRead' }>
            | Extract<ServerRequest, { method: 'terminal.preview' }>
            | Extract<ServerRequest, { method: 'mobile.session.create' }>,
        context: CommandExecutionContext,
        domainService: ServerDomainService,
    ) => Promise<void>;
}

const requiredGateway = (gateway: MobileGateway | undefined): MobileGateway => {
    if (!gateway) throw new CaxriError('UNAVAILABLE', 'Mobile access is unavailable');
    return gateway;
};

const terminalForPrincipal = async (
    domainService: ServerDomainService,
    principal: Principal,
    terminalId: string,
) => {
    const result = await domainService.request('terminal.queryForPrincipal', {
        principal,
        query: { mode: 'show', selector: terminalId },
    });
    const terminal = result.terminals.at(0);
    if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
    return terminal;
};

const sessionForPrincipal = async (
    domainService: ServerDomainService,
    principal: Principal,
    sessionId: string,
) => {
    const result = await domainService.request('session.queryForPrincipal', {
        principal,
        query: { mode: 'show', selector: sessionId },
    });
    const session = result.sessions.at(0);
    if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
    return session;
};

/**
 * Owns the default-off LAN listener and keeps paired-device authorization out of the general Server dispatcher.
 */
export const openMobileAccessController = async (options: {
    directory: string;
    hostDisplayName?: string;
    onOpenError?: () => Promise<void>;
    registryPath: string;
    selectAddress?: () => string;
}): Promise<MobileAccessController> => {
    let registry: MobileDeviceRegistry;
    try {
        registry = await MobileDeviceRegistry.open({
            directory: options.directory,
            path: options.registryPath,
        });
    } catch (error) {
        await options.onOpenError?.();
        throw error;
    }
    let gateway: MobileGateway | undefined;
    const hostDisplayName = mobileHostDisplayName(options.hostDisplayName ?? hostname());
    let isClosed = false;
    let authorityTail = Promise.resolve();
    const inFlightOperations = new Map<string, Set<AbortController>>();
    const assertOpen = (): void => {
        if (isClosed) throw new CaxriError('UNAVAILABLE', 'Mobile access is shutting down');
    };
    const withAuthority = <T>(task: () => Promise<T> | T): Promise<T> => {
        const previous = authorityTail;
        const release = Promise.withResolvers<void>();
        authorityTail = release.promise;
        return (async () => {
            await previous;
            try {
                return await task();
            } finally {
                release.resolve();
            }
        })();
    };
    const currentPairedPrincipal = (principal: Principal, method: string) => {
        if (principal.kind !== 'paired-device')
            throw new CaxriError('FORBIDDEN', 'Paired device principal is required');
        const current = registry.currentPrincipal(principal.deviceId, principal.generation);
        if (
            current.kind !== 'paired-device' ||
            current.id !== principal.id ||
            current.role !== principal.role ||
            current.projectIds.length !== principal.projectIds.length ||
            current.projectIds.some((projectId, index) => projectId !== principal.projectIds[index])
        )
            throw new CaxriError('FORBIDDEN', 'Paired device authorization changed');
        if (!isMobileGatewayMethodAllowedForRole(current.role, method))
            throw new CaxriError('FORBIDDEN', 'Paired device role does not allow this method');
        return current;
    };
    const authorizeSubscription = async (
        principal: Principal,
        resource: MobileSubscriptionResource,
        domainService: ServerDomainService,
    ): Promise<void> => {
        const current = currentPairedPrincipal(
            principal,
            resource.kind === 'terminal' ? 'terminal.preview' : 'mobile.dashboard',
        );
        if (resource.kind === 'terminal')
            await terminalForPrincipal(domainService, current, resource.terminalId);
        else if (resource.kind === 'conversation' || resource.kind === 'changes')
            await sessionForPrincipal(domainService, current, resource.sessionId);
    };
    const operationKey = (deviceId: string, generation: number): string =>
        `${deviceId}:${generation}`;
    const registerOperation = (principal: Extract<Principal, { kind: 'paired-device' }>) => {
        const cancellation = new AbortController();
        const key = operationKey(principal.deviceId, principal.generation);
        const controllers = inFlightOperations.get(key) ?? new Set<AbortController>();
        controllers.add(cancellation);
        inFlightOperations.set(key, controllers);
        return cancellation;
    };
    const abortOperations = (identity?: { deviceId: string; generation: number }): void => {
        for (const [key, controllers] of inFlightOperations) {
            if (identity && key !== operationKey(identity.deviceId, identity.generation)) continue;
            for (const controller of controllers) controller.abort();
        }
    };
    const unregisterOperation = (
        identity: { deviceId: string; generation: number },
        controller: AbortController,
    ): void => {
        const key = operationKey(identity.deviceId, identity.generation);
        const controllers = inFlightOperations.get(key);
        controllers?.delete(controller);
        if (controllers?.size === 0) inFlightOperations.delete(key);
    };

    return {
        authorizePairedDeviceMethod: (principal, method) => {
            currentPairedPrincipal(principal, method);
        },
        attach: (adapter, bootId, protocolIdentity, domainService, terminalExecution) => {
            assertOpen();
            gateway = new MobileGateway({
                adapters: { server: adapter },
                bootId,
                protocolIdentity,
                registry,
                terminalExecution,
                authorizePairedDeviceMethod: (principal, method) => {
                    currentPairedPrincipal(principal, method);
                },
                authorizeSubscription: (principal, resource) =>
                    authorizeSubscription(principal, resource, domainService),
                beginConversationSubscription: async (principal, sessionId) => {
                    const current = currentPairedPrincipal(principal, 'mobile.timeline.read');
                    await sessionForPrincipal(domainService, current, sessionId);
                    const watched = await domainService.request('mobile.timeline.watchInternal', {
                        sessionId,
                        principal: current,
                    });
                    const close = () => {
                        if (!watched.terminalId) return;
                        // eslint-disable-next-line no-void -- Connection teardown cannot block on a Server IPC reply.
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
                    if (resource.kind === 'dashboard') return event.event === 'state.changed';
                    if (resource.kind === 'terminal')
                        return (
                            event.event === 'terminal.output' &&
                            event.payload.terminalId === resource.terminalId
                        );
                    if (resource.kind === 'changes')
                        return (
                            event.event === 'git.changed' &&
                            event.payload.sessionIds.includes(resource.sessionId)
                        );
                    if (event.event !== 'agentTranscript.changed') return false;
                    const terminal = await terminalForPrincipal(
                        domainService,
                        principal,
                        event.payload.terminalId,
                    );
                    return terminal.sessionId === resource.sessionId;
                },
                ...(options.selectAddress && { selectAddress: options.selectAddress }),
            });
        },
        close: () =>
            withAuthority(async () => {
                isClosed = true;
                abortOperations();
                await gateway?.close();
            }),
        publish: (event) => gateway?.publish(event),
        invokeControl: async (request, context, domainService, resolveAgentEndpoint) => {
            const activeGateway = requiredGateway(gateway);
            switch (request.method) {
                case 'mobile.access.status':
                    return activeGateway.status();
                case 'mobile.access.enable':
                    return withAuthority(() => {
                        assertOpen();
                        return activeGateway.enable();
                    });
                case 'mobile.access.disable':
                    return withAuthority(() => {
                        assertOpen();
                        abortOperations();
                        return activeGateway.disable();
                    });
                case 'mobile.device.list':
                    return { devices: activeGateway.devices() };
                case 'mobile.dashboard': {
                    const paired =
                        context.principal.kind === 'paired-device'
                            ? currentPairedPrincipal(context.principal, request.method)
                            : undefined;
                    const [projects, sessions, terminals] = await Promise.all([
                        domainService.request('project.queryForPrincipal', {
                            principal: context.principal,
                            query: { mode: 'list' },
                        }),
                        domainService.request('session.queryForPrincipal', {
                            principal: context.principal,
                            query: { mode: 'list' },
                        }),
                        domainService.request('terminal.queryForPrincipal', {
                            principal: context.principal,
                            query: { mode: 'list' },
                        }),
                    ]);
                    const grantedProjectIds =
                        context.principal.kind === 'paired-device'
                            ? new Set(context.principal.projectIds)
                            : undefined;
                    const visibleProjects = grantedProjectIds
                        ? projects.projects.filter((project) => grantedProjectIds.has(project.id))
                        : projects.projects;
                    return buildMobileDashboard({
                        hostDisplayName,
                        deviceRole: paired?.role ?? null,
                        projects: visibleProjects,
                        sessions: sessions.sessions,
                        terminals: terminals.terminals,
                        resolveAgentEndpoint,
                    });
                }
                case 'mobile.session.show': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    const session = await sessionForPrincipal(
                        domainService,
                        principal,
                        request.params.sessionId,
                    );
                    const [projects, terminals] = await Promise.all([
                        domainService.request('project.queryForPrincipal', {
                            principal,
                            query: { mode: 'show', selector: session.projectId },
                        }),
                        session.primaryAgentTerminalId
                            ? domainService.request('terminal.queryForPrincipal', {
                                  principal,
                                  query: {
                                      mode: 'show',
                                      selector: session.primaryAgentTerminalId,
                                  },
                              })
                            : domainService.request('terminal.queryForPrincipal', {
                                  principal,
                                  query: { mode: 'list', sessionId: session.id },
                              }),
                    ]);
                    const projected = buildMobileDashboard({
                        hostDisplayName,
                        deviceRole: principal.role,
                        projects: projects.projects,
                        sessions: [session],
                        terminals: terminals.terminals,
                        resolveAgentEndpoint,
                    }).sessions.at(0);
                    if (!projected) throw new CaxriError('NOT_FOUND', 'Session not found');
                    currentPairedPrincipal(principal, request.method);
                    return { session: projected };
                }
                case 'mobile.timeline.read': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    await sessionForPrincipal(domainService, principal, request.params.sessionId);
                    const result = await domainService.request('mobile.timeline.readInternal', {
                        ...request.params,
                        principal,
                    });
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
                case 'mobile.agent.submit': {
                    const { principal, cancellation } = await withAuthority(() => {
                        assertOpen();
                        if (!activeGateway.status().enabled)
                            throw new CaxriError('FORBIDDEN', 'Mobile access is disabled');
                        const principal = currentPairedPrincipal(context.principal, request.method);
                        return { principal, cancellation: registerOperation(principal) };
                    });
                    try {
                        const result = await domainService.requestWithSignal(
                            'mobile.agent.submitInternal',
                            { ...request.params, principal },
                            cancellation.signal,
                        );
                        return await withAuthority(() => {
                            if (cancellation.signal.aborted)
                                throw new CaxriError('CANCELLED', 'Mobile submission was canceled');
                            currentPairedPrincipal(principal, request.method);
                            return result;
                        });
                    } finally {
                        await withAuthority(() => unregisterOperation(principal, cancellation));
                    }
                }
                case 'mobile.session.create': {
                    /**
                     * Keep only admission in the authority queue; Terminal launch may outlive revocation. A revoked
                     * client cannot receive a result after a durable create and must reconcile from dashboard when
                     * paired again before retrying.
                     */
                    const { principal, cancellation } = await withAuthority(() => {
                        assertOpen();
                        const principal = currentPairedPrincipal(context.principal, request.method);
                        if (!principal.projectIds.includes(request.params.projectId))
                            throw new CaxriError('NOT_FOUND', 'Project not found');
                        const cancellation = registerOperation(principal);
                        return { principal, cancellation };
                    });
                    try {
                        const result = await domainService.requestWithSignal(
                            'mobile.session.createForPrincipal',
                            { ...request.params, principal },
                            cancellation.signal,
                        );
                        return await withAuthority(() => {
                            if (cancellation.signal.aborted)
                                throw new CaxriError(
                                    'CANCELLED',
                                    'Mobile Session creation was canceled',
                                );
                            currentPairedPrincipal(principal, request.method);
                            return result;
                        });
                    } finally {
                        await withAuthority(() => unregisterOperation(principal, cancellation));
                    }
                }
                case 'mobile.terminal.takeOver':
                case 'mobile.terminal.release':
                case 'mobile.terminal.input': {
                    const principal = currentPairedPrincipal(context.principal, request.method);
                    await terminalForPrincipal(domainService, principal, request.params.terminalId);
                    const current = currentPairedPrincipal(principal, request.method);
                    await terminalForPrincipal(domainService, current, request.params.terminalId);
                    const observer = activeGateway.terminalSubscription(
                        context,
                        request.params.subscriptionId,
                        request.params.terminalId,
                    );
                    if (request.method === 'mobile.terminal.takeOver')
                        return observer.takeOver(request.params.expectedGeneration, {
                            cols: request.params.cols,
                            rows: request.params.rows,
                        });
                    if (request.method === 'mobile.terminal.release') {
                        await observer.releaseTakeOver(request.params.expectedGeneration);
                        return null;
                    }
                    await observer.input(request.params.expectedGeneration, request.params.data);
                    return null;
                }
                case 'mobile.pairing.create': {
                    return withAuthority(async () => {
                        assertOpen();
                        const visible = await domainService.request('project.queryForPrincipal', {
                            principal: context.principal,
                            query: { mode: 'list' },
                        });
                        const projectIds = new Set(visible.projects.map((project) => project.id));
                        if (
                            request.params.projectIds.some(
                                (projectId) => !projectIds.has(projectId),
                            )
                        )
                            throw new CaxriError('NOT_FOUND', 'Pairing Project not found');
                        return activeGateway.createPairing(request.params.projectIds);
                    });
                }
                default:
                    throw new CaxriError('INTERNAL', 'Mobile control method is not implemented');
            }
        },
        invokeDesktopOperation: (request) =>
            withAuthority(async () => {
                assertOpen();
                const revocation = requiredGateway(gateway).revoke(
                    request.params.deviceId,
                    request.params.expectedGeneration,
                );
                abortOperations({
                    deviceId: request.params.deviceId,
                    generation: request.params.expectedGeneration,
                });
                return revocation;
            }),
        validatePairedDeviceRequest: async (request, context, domainService) => {
            const current = currentPairedPrincipal(context.principal, request.method);
            if (request.method === 'mobile.session.create') {
                if (!current.projectIds.includes(request.params.projectId))
                    throw new CaxriError('NOT_FOUND', 'Project not found');
                const visible = await domainService.request('project.queryForPrincipal', {
                    principal: current,
                    query: { mode: 'show', selector: request.params.projectId },
                });
                if (visible.projects.every((project) => project.id !== request.params.projectId))
                    throw new CaxriError('NOT_FOUND', 'Project not found');
                return;
            }
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

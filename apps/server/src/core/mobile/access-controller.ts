import { Buffer } from 'node:buffer';
import { hostname } from 'node:os';

import type {
    CommandAdapter,
    CommandExecutionContext,
    MobileDeviceRole,
    Principal,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import { CaxriError, MOBILE_SHORT_REPLY_MAX_BYTES } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { buildMobileDashboard } from './dashboard';
import { MobileDeviceRegistry } from './device-registry';
import { MobileGateway } from './gateway';

type TerminalSendParameters = Extract<ServerRequest, { method: 'terminal.send' }>['params'];
const mobileGatewayMethodsByRole = {
    view: ['mobile.dashboard', 'terminal.preview'],
    reply: ['mobile.dashboard', 'terminal.preview', 'session.markRead', 'terminal.send'],
    control: [
        'mobile.dashboard',
        'terminal.preview',
        'session.markRead',
        'terminal.send',
        'mobile.session.create',
    ],
} as const satisfies Record<MobileDeviceRole, readonly string[]>;

export const isMobileGatewayMethodAllowedForRole = (
    role: MobileDeviceRole,
    method: string,
): boolean => (mobileGatewayMethodsByRole[role] as readonly string[]).includes(method);

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
            | 'mobile.session.create'
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
    ) => void;
    close: () => Promise<void>;
    invokeControl: (
        request: MobileControlRequest,
        context: CommandExecutionContext,
        domainService: ServerDomainService,
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
    invokeShortReply: (
        context: CommandExecutionContext,
        parameters: TerminalSendParameters,
        domainService: ServerDomainService,
        invoke: (signal: AbortSignal) => Promise<unknown>,
    ) => Promise<unknown>;
}

const requiredGateway = (gateway: MobileGateway | undefined): MobileGateway => {
    if (!gateway) throw new CaxriError('UNAVAILABLE', 'Mobile access is unavailable');
    return gateway;
};

const terminalForPrincipal = async (
    domainService: ServerDomainService,
    context: CommandExecutionContext,
    terminalId: string,
) => {
    const result = await domainService.request('terminal.queryForPrincipal', {
        principal: context.principal,
        query: { mode: 'show', selector: terminalId },
    });
    const terminal = result.terminals.at(0);
    if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
    return terminal;
};

const sessionForPrincipal = async (
    domainService: ServerDomainService,
    context: CommandExecutionContext,
    sessionId: string,
) => {
    const result = await domainService.request('session.queryForPrincipal', {
        principal: context.principal,
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
        attach: (adapter, bootId, protocolIdentity) => {
            assertOpen();
            gateway = new MobileGateway({
                adapters: { server: adapter },
                bootId,
                protocolIdentity,
                registry,
                authorizePairedDeviceMethod: (principal, method) => {
                    currentPairedPrincipal(principal, method);
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
        invokeControl: async (request, context, domainService) => {
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
                    if (context.principal.kind === 'paired-device')
                        currentPairedPrincipal(context.principal, request.method);
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
                        projects: visibleProjects,
                        sessions: sessions.sessions,
                        terminals: terminals.terminals,
                    });
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
                await terminalForPrincipal(domainService, context, request.params.terminalId);
                return;
            }
            await sessionForPrincipal(domainService, context, request.params.sessionId);
        },
        invokeShortReply: async (context, parameters, domainService, invoke) => {
            await withAuthority(() => {
                assertOpen();
                currentPairedPrincipal(context.principal, 'terminal.send');
                const activeGateway = requiredGateway(gateway);
                if (!activeGateway.status().enabled)
                    throw new CaxriError('FORBIDDEN', 'Mobile access is disabled');
            });
            const hasControlCharacter = [...parameters.text].some((character) => {
                const code = character.codePointAt(0)!;
                return code < 32 || (code >= 127 && code <= 159);
            });
            if (
                hasControlCharacter ||
                !parameters.enter ||
                parameters.attentionEpoch === undefined ||
                parameters.text.trim().length === 0 ||
                Buffer.byteLength(parameters.text, 'utf8') > MOBILE_SHORT_REPLY_MAX_BYTES
            )
                throw new CaxriError(
                    'VALIDATION',
                    'Mobile replies require one bounded plain-text submitted message',
                );
            const terminal = await terminalForPrincipal(
                domainService,
                context,
                parameters.terminalId,
            );
            const session = await sessionForPrincipal(domainService, context, terminal.sessionId);
            if (
                terminal.kind === 'shell' ||
                session.primaryAgentTerminalId !== terminal.id ||
                session.lastActivityState !== 'waiting' ||
                session.attentionEpoch !== parameters.attentionEpoch
            )
                throw new CaxriError(
                    'CONFLICT',
                    'Agent attention changed before the reply was accepted',
                );
            const { principal, cancellation } = await withAuthority(() => {
                assertOpen();
                if (!requiredGateway(gateway).status().enabled)
                    throw new CaxriError('FORBIDDEN', 'Mobile access is disabled');
                const principal = currentPairedPrincipal(context.principal, 'terminal.send');
                return { principal, cancellation: registerOperation(principal) };
            });
            try {
                if (cancellation.signal.aborted)
                    throw new CaxriError('CANCELLED', 'Mobile reply was canceled');
                /**
                 * The domain checks this signal after dispatch admission and before consuming attention or writing.
                 */
                const result = await invoke(cancellation.signal);
                return await withAuthority(() => {
                    if (cancellation.signal.aborted)
                        throw new CaxriError('CANCELLED', 'Mobile reply was canceled');
                    currentPairedPrincipal(principal, 'terminal.send');
                    return result;
                });
            } finally {
                await withAuthority(() => unregisterOperation(principal, cancellation));
            }
        },
    };
};

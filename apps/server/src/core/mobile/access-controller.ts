import { Buffer } from 'node:buffer';

import type {
    CommandAdapter,
    CommandExecutionContext,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import { CaxriError, MOBILE_SHORT_REPLY_MAX_BYTES } from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { buildMobileDashboard } from './dashboard';
import { MobileDeviceRegistry } from './device-registry';
import { MobileGateway } from './gateway';

type TerminalSendParameters = Extract<ServerRequest, { method: 'terminal.send' }>['params'];
type MobileControlRequest = Extract<
    ServerRequest,
    {
        method:
            | 'mobile.access.disable'
            | 'mobile.access.enable'
            | 'mobile.access.status'
            | 'mobile.device.list'
            | 'mobile.dashboard'
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
    validatePairedDeviceRequest: (
        request:
            | Extract<ServerRequest, { method: 'session.markRead' }>
            | Extract<ServerRequest, { method: 'terminal.preview' }>,
        context: CommandExecutionContext,
        domainService: ServerDomainService,
    ) => Promise<void>;
    invokeShortReply: (
        context: CommandExecutionContext,
        parameters: TerminalSendParameters,
        domainService: ServerDomainService,
        invoke: () => Promise<unknown>,
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
    let isClosed = false;
    let authorityTail = Promise.resolve();
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

    return {
        attach: (adapter, bootId, protocolIdentity) => {
            assertOpen();
            gateway = new MobileGateway({
                adapters: { server: adapter },
                bootId,
                protocolIdentity,
                registry,
                ...(options.selectAddress && { selectAddress: options.selectAddress }),
            });
        },
        close: () =>
            withAuthority(async () => {
                isClosed = true;
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
                        return activeGateway.disable();
                    });
                case 'mobile.device.list':
                    return { devices: activeGateway.devices() };
                case 'mobile.dashboard': {
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
                    return buildMobileDashboard({
                        projects: projects.projects,
                        sessions: sessions.sessions,
                        terminals: terminals.terminals,
                    });
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
            withAuthority(() => {
                assertOpen();
                return requiredGateway(gateway).revoke(
                    request.params.deviceId,
                    request.params.expectedGeneration,
                );
            }),
        validatePairedDeviceRequest: async (request, context, domainService) => {
            if (context.principal.kind !== 'paired-device')
                throw new CaxriError('FORBIDDEN', 'Paired device principal is required');
            registry.currentPrincipal(context.principal.deviceId, context.principal.generation);
            if (request.method === 'terminal.preview') {
                await terminalForPrincipal(domainService, context, request.params.terminalId);
                return;
            }
            await sessionForPrincipal(domainService, context, request.params.sessionId);
        },
        invokeShortReply: (context, parameters, domainService, invoke) =>
            withAuthority(async () => {
                assertOpen();
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
                const activeGateway = requiredGateway(gateway);
                if (!activeGateway.status().enabled)
                    throw new CaxriError('FORBIDDEN', 'Mobile access is disabled');
                const terminal = await terminalForPrincipal(
                    domainService,
                    context,
                    parameters.terminalId,
                );
                const session = await sessionForPrincipal(
                    domainService,
                    context,
                    terminal.sessionId,
                );
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
                if (context.principal.kind !== 'paired-device')
                    throw new CaxriError('FORBIDDEN', 'Paired device principal is required');
                registry.currentPrincipal(context.principal.deviceId, context.principal.generation);
                return invoke();
            }),
    };
};

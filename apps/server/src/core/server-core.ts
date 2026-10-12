import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import process from 'node:process';

import type {
    CommandAdapter,
    ProtocolEventEnvelope,
    ServerEvent,
    ServerIdleExitReason,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    getMethodSpec,
    isServerRequest,
    isTransientServerEvent,
    projectObservableEventRecovery,
    protocolFeatures,
    resolveLogLevel,
} from '@caxri/protocol';
import { logEventCatalog, startEventLoopMonitor, StructuredLogger } from '@caxri/system';

import { createServerDomainService } from '../core/create-domain-service';
import { warmServerExecutablePath } from '../domains/executables';
import { agentCommandRequest } from './agent-command-request';
import { createAgentEndpointControl } from './agent-endpoints/control';
import { AgentEndpointRegistry } from './agent-endpoints/registry';
import { retireEndpointsForOperation } from './agent-endpoints/retire-for-operation';
import { sendAgentMessage } from './agent-message-send';
import { ControlServer } from './control-server';
import type { CoreForwardedMethod } from './core-methods';
import { createAgentMessaging } from './create-agent-messaging';
import {
    invokeDelegationAccess,
    isDelegationAccessRequest,
    openDelegationAccess,
} from './delegation-access';
import { ServerDesktopRouter } from './desktop-router';
import {
    invokeExtensionControlRequest,
    isExtensionControlRequest,
} from './extensions/control-requests';
import { createExtensionService } from './extensions/create-service';
import { routeExtensionDomainEvent } from './extensions/domain-events';
import type { ExtensionService } from './extensions/service';
import { createIdleExitConnectionTracker, createIdleExitMonitor } from './idle-exit';
import {
    isMobileControlRequest,
    openMobileAccessController,
    resolveMobileAgentEndpoint,
} from './mobile';
import { MutationAdmission } from './mutation-admission';
import { assertProjectScope, projectScope } from './principal-project-scope';
import { acquireServerProfile } from './profile';
import { createServerRecoveryJournal, serverRecoverySnapshot } from './recovery-journal';
import {
    logDurableReceipt,
    logDurableRecovery,
    prepareServerEventForDelivery,
} from './recovery-observability';
import { principalRequestKey, RequestCancellationRegistry } from './request-cancellation';
import type { ServerCore, ServerCoreOptions } from './server-core-contract';
import type { CommandStopFallbackReference } from './server-core-control-callbacks';
import { createServerCoreControlCallbacks } from './server-core-control-callbacks';
import { createTerminalExecution } from './terminal-host/create-execution';
import { invokeTerminalSend } from './terminal-send';

export type { ServerCore, ServerCoreOptions } from './server-core-contract';
/**
 * Starts the profile owner, authenticated local transport, domain services, and Extension Host supervision.
 */
export async function startServerCore(options: ServerCoreOptions): Promise<ServerCore> {
    const startedAt = Date.now();
    const logger =
        options.logger ??
        new StructuredLogger(
            join(options.userDataPath, 'logs'),
            'server-core',
            resolveLogLevel(process.env),
        );
    const eventLoopMonitor = startEventLoopMonitor(logger);
    // Fired before any `await` so the login-shell PATH probe overlaps startup instead of blocking the first command.
    warmServerExecutablePath();
    const lease = await acquireServerProfile({
        logger,
        startedAt,
        userDataPath: options.userDataPath,
        version: options.version,
    });
    const releaseStartup = async () => {
        eventLoopMonitor.stop();
        await lease.release();
    };
    // Fed by `ControlServer` and `MobileGateway` below into one aggregate for `docs/adr/0010-server-core-idle-exit.md`.
    const idleExitConnections = createIdleExitConnectionTracker();
    const mobileAccess = await openMobileAccessController({
        logger,
        directory: lease.paths.directory,
        ...(options.mobileHostDisplayName && { hostDisplayName: options.mobileHostDisplayName }),
        onConnectionCountChanged: (count) => idleExitConnections.updateMobileCount(count),
        registryPath: lease.paths.mobileDevices,
        ...(options.mobileUpdateDirectory && { updateDirectory: options.mobileUpdateDirectory }),
        onOpenError: releaseStartup,
    });
    logger.updateBaseContext({ bootId: lease.identity.processIdentity, buildId: options.buildId });
    const delegationAccess = await openDelegationAccess(lease.paths.directory, releaseStartup);
    const agentEndpoints = new AgentEndpointRegistry(lease.identity.processIdentity, { logger });
    let server: ControlServer | undefined;
    const { providerMessaging, agentInbox } = createAgentMessaging(agentEndpoints, () => server);
    const endpointControl = createAgentEndpointControl(agentEndpoints);
    const terminalExecution = createTerminalExecution({
        appVersion: options.version,
        bootId: lease.identity.processIdentity,
        buildId: options.buildId ?? 'unknown',
        commit: options.commit,
        executable: options.executable,
        logger,
        override: options.terminalExecution,
        terminalHostPath: options.terminalHostPath,
        userDataPath: lease.paths.userDataPath,
    });
    const domainService = createServerDomainService({
        hasMobileAttentionRecipient: (projectId) => mobileAccess.hasAttentionRecipient(projectId),
        agentEndpointControl: endpointControl,
        agentHooksPath: options.agentHooksPath,
        createServices: options.createDomainServices,
        executable: options.executable,
        logger,
        projectSearch: options.projectSearch,
        terminalExecution,
        userDataPath: lease.paths.userDataPath,
    });
    let extensionService: ExtensionService | undefined;
    let desktopRouter: ServerDesktopRouter | undefined;
    const requireDesktopRouter = (): ServerDesktopRouter => {
        if (!desktopRouter) throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
        return desktopRouter;
    };
    let stopPromise: Promise<void> | undefined;
    const commandStopFallbackReference: CommandStopFallbackReference = { current: undefined };
    const mutationAdmission = new MutationAdmission();
    const { promise: stopped, resolve: resolveStopped } = Promise.withResolvers<void>();
    const { promise: stopping, resolve: resolveStopping } = Promise.withResolvers<void>();
    const dispatchWaitIds = new Map<string, Set<string>>();
    const requestCancellations = new RequestCancellationRegistry();
    const forwardDomainOperation = async (
        request: ServerOperationRequest,
        signal?: AbortSignal,
    ): Promise<unknown> => {
        const spec = getMethodSpec(request.method);
        if (!spec) throw new CaxriError('VALIDATION', 'Unknown Runtime command');
        if (spec.effect === 'read')
            return domainService.forward(request.method, request.params, undefined, signal);
        return mutationAdmission.run(async () => {
            retireEndpointsForOperation(agentEndpoints, request);
            return domainService.forward(request.method, request.params, undefined, signal);
        });
    };
    const recoveryJournal = createServerRecoveryJournal(
        serverRecoverySnapshot(domainService),
        (observation) => logDurableRecovery(logger, observation),
    );
    const deliver = (candidate: ServerEvent, persistedEnvelope?: ProtocolEventEnvelope): void => {
        const event = prepareServerEventForDelivery(logger, candidate);
        if (event.event === 'terminal.exit')
            agentEndpoints.retireTerminal(event.payload.terminalId);
        else if (event.event === 'runtime.status')
            logger.write(
                event.payload.status === 'failed' ? 'error' : 'info',
                logEventCatalog.serverCore.status,
                {
                    fields: {
                        status: event.payload.status,
                        restartCount: event.payload.restartCount,
                    },
                },
            );
        /**
         * Skip refreshes emitted after the Extension Host enters teardown.
         */
        if (!stopPromise) {
            // eslint-disable-next-line unicorn/prefer-await -- event delivery cannot await a best-effort refresh
            routeExtensionDomainEvent(extensionService, domainService, event).catch(
                (error: unknown) =>
                    logger.write('error', logEventCatalog.extensionHost.contextRefreshFailed, {
                        fields: { message: error instanceof Error ? error.message : String(error) },
                    }),
            );
        }
        if (isTransientServerEvent(event)) server?.broadcast(event);
        else {
            const envelope = persistedEnvelope ?? recoveryJournal.publish(event);
            if (envelope) server?.broadcast(envelope);
        }
        mobileAccess.publish(event);
    };
    domainService.onEvent(deliver);
    const stop = (reason = 'requested'): Promise<void> => {
        mutationAdmission.close();
        resolveStopping();
        idleExitConnections.stop();
        // Lands even if Terminal Host exits (OS SIGTERM to the tree) before `domainService.shutdown()` runs below.
        terminalExecution.markCoreStopping?.();
        // Same race for the Extension Host, which is shut down last: its signal-driven exit must not restart it.
        extensionService?.markCoreStopping();
        stopPromise ??= (async () => {
            logger.write('info', logEventCatalog.serverCore.stopping, { fields: { reason } });
            eventLoopMonitor.stop();
            // Yields once so `stopPromise` is assigned below before a synchronous domain-shutdown side effect (e.g. a
            // state.changed emit) can hit `deliver`'s `if (!stopPromise)` extension-refresh branch.
            await Promise.resolve();
            // Captures every live Terminal's snapshot via `host.shutdown` first: the Extension Host's own graceful
            // shutdown can wait up to 5s for its child to exit, and under the previous ordering that delay let an
            // OS-initiated SIGTERM beat Core's `host.shutdown` request to Terminal Host.
            await domainService.shutdown();
            await mobileAccess.close();
            await server?.close();
            agentInbox.close();
            await providerMessaging.close();
            await extensionService?.shutdown();
            await lease.release();
            logger.write('info', logEventCatalog.serverCore.stopped, { fields: { reason } });
            resolveStopped();
        })();
        return stopPromise;
    };

    const serverAdapter: CommandAdapter = {
        async invoke(request, context, invocation) {
            if (!isServerRequest(request))
                throw new CaxriError(
                    'INTERNAL',
                    `Host received a desktop-owned method: ${request.method}`,
                );
            if (isMobileControlRequest(request))
                return mobileAccess.invokeControl(
                    request,
                    context,
                    domainService,
                    (terminalId) => resolveMobileAgentEndpoint(agentEndpoints, terminalId),
                    forwardDomainOperation,
                );
            if (isDelegationAccessRequest(request))
                return invokeDelegationAccess(
                    request,
                    context,
                    delegationAccess,
                    forwardDomainOperation,
                );
            if (
                context.principal.kind === 'paired-device' &&
                (request.method === 'terminal.preview' || request.method === 'session.markRead')
            )
                await mobileAccess.validatePairedDeviceRequest(request, context, domainService);
            if (isExtensionControlRequest(request))
                return invokeExtensionControlRequest(request, extensionService, domainService);
            switch (request.method) {
                case 'events.recover':
                    return recoveryJournal.recover(request.params);
                case 'events.query':
                    return projectObservableEventRecovery(
                        await recoveryJournal.recover(request.params),
                    );
                case 'requests.cancel':
                    return {
                        cancelled: requestCancellations.cancel(
                            principalRequestKey(context, request.params.requestId),
                        ),
                    };
                case 'agent.context':
                    return agentEndpoints.context(context);
                case 'agent.list':
                    return { agents: agentEndpoints.list(context) };
                case 'agent.grants':
                    return { grants: agentEndpoints.grants(request.params.endpoint) };
                case 'agent.grant':
                    return agentEndpoints.grant(
                        request.params.endpoint,
                        request.params.policy,
                        request.params.ttlMs,
                    );
                case 'agent.revoke':
                    return {
                        revoked: agentEndpoints.revoke(
                            request.params.endpoint,
                            request.params.grantId,
                        ),
                    };
                case 'agent.dispatch.start':
                case 'agent.dispatch.resume':
                case 'agent.delegation.create':
                case 'agent.delegation.presets':
                case 'agent.delegation.stop':
                case 'agent.delegation.status':
                case 'agent.delegation.result':
                    return forwardDomainOperation(
                        agentCommandRequest(request, context, invocation.requestId, agentEndpoints),
                    );
                case 'agent.delegation.wait': {
                    const operation = agentCommandRequest(
                        request,
                        context,
                        invocation.requestId,
                        agentEndpoints,
                    );
                    return requestCancellations.runDisconnectable(
                        principalRequestKey(context, invocation.requestId),
                        (signal) => forwardDomainOperation(operation, signal),
                    );
                }
                case 'agent.dispatch.status':
                    return domainService.request('agent.dispatch.statusInternal', {
                        dispatchId: request.params.dispatchId,
                        projectScope: projectScope(context),
                    });
                case 'agent.dispatch.wait': {
                    const key = principalRequestKey(context, invocation.requestId);
                    const waitId = randomUUID();
                    const waitIds = dispatchWaitIds.get(key) ?? new Set<string>();
                    waitIds.add(waitId);
                    dispatchWaitIds.set(key, waitIds);
                    try {
                        return await domainService.request('agent.dispatch.waitInternal', {
                            afterRevision: request.params.afterRevision,
                            dispatchId: request.params.dispatchId,
                            projectScope: projectScope(context),
                            timeoutMs: request.params.timeoutMs,
                            waitId,
                        });
                    } finally {
                        waitIds.delete(waitId);
                        if (waitIds.size === 0) dispatchWaitIds.delete(key);
                    }
                }
                case 'agent.control.interrupt':
                case 'agent.control.stop': {
                    if (context.principal.kind === 'paired-device') {
                        if (request.method !== 'agent.control.interrupt')
                            throw new CaxriError(
                                'FORBIDDEN',
                                'Mobile device cannot stop Agent process',
                            );
                        mobileAccess.authorizePairedDeviceMethod(context.principal, request.method);
                    }
                    const endpoint = agentEndpoints.resolve(request.params.endpoint);
                    assertProjectScope(context, endpoint.projectId);
                    return forwardDomainOperation({
                        method:
                            request.method === 'agent.control.interrupt'
                                ? 'agent.control.interruptInternal'
                                : 'agent.control.stopInternal',
                        params: request.params,
                    });
                }
                case 'terminal.send': {
                    if (context.principal.kind === 'paired-device')
                        throw new CaxriError(
                            'FORBIDDEN',
                            'Use mobile.agent.submit for mobile input',
                        );
                    const invoke = (signal?: AbortSignal) =>
                        forwardDomainOperation(
                            { method: 'terminal.sendInternal', params: request.params },
                            signal,
                        );
                    return invokeTerminalSend({
                        invoke,
                        logger,
                        parameters: request.params,
                        principalKind: context.principal.kind,
                    });
                }
                case 'agent.message.send':
                    return sendAgentMessage({
                        agentEndpoints,
                        agentInbox,
                        context,
                        domainService,
                        mutationAdmission,
                        parameters: request.params,
                        requestId: invocation.requestId,
                    });
                case 'agent.message.reply': {
                    if (request.params.wake)
                        throw new CaxriError(
                            'VALIDATION',
                            'Agent message replies cannot wake a target',
                        );
                    return agentInbox.reply(context, request.params, invocation.requestId);
                }
                case 'agent.message.wait':
                    return agentInbox.wait(context, request.params.timeoutMs, invocation.requestId);
                case 'agent.message.check':
                    return agentInbox.check(context, invocation.requestId);
                case 'agent.message.receipt':
                    return agentInbox.receipt(context, request.params.messageId);
                case 'agent.message.policy.get':
                    return agentInbox.policy(context);
                case 'agent.message.policy.set':
                    return agentInbox.setPolicy(context, request.params);
                case 'agent.message.held':
                    return { messages: agentInbox.listHeld() };
                case 'agent.message.held.get':
                    return agentInbox.heldDetail(request.params.messageId);
                case 'agent.message.approve':
                    return agentInbox.approve(request.params.messageId);
                case 'agent.message.deny':
                    return agentInbox.deny(request.params.messageId);
                case 'host.status': {
                    const health = await domainService.request('app.health');
                    return {
                        profileId: lease.identity.profileId,
                        version: options.version,
                        ...(options.buildId && { buildId: options.buildId }),
                        ...(process.env.CAXRI_GIT_COMMIT && {
                            commit: process.env.CAXRI_GIT_COMMIT,
                        }),
                        pid: process.pid,
                        startedAt,
                        clientCount: server?.clientCount() ?? 0,
                        activePtyCount: health.activePtyCount,
                        protocolVersion: CAXRI_PROTOCOL_VERSION,
                        protocolCompatible: true,
                        desktop: (await desktopRouter?.status()) ?? { state: 'offline' },
                    };
                }
                case 'desktop.status':
                    return (await desktopRouter?.status()) ?? { state: 'offline' };
                case 'desktop.focus':
                    return requireDesktopRouter().focus(request.params.launchIfNeeded);
                case 'desktop.openPath':
                case 'desktop.openProject':
                case 'desktop.openFile': {
                    const kind =
                        request.method === 'desktop.openPath'
                            ? undefined
                            : request.method === 'desktop.openFile'
                              ? 'file'
                              : 'directory';
                    return requireDesktopRouter().open('open', kind, request.params);
                }
                case 'files.reveal':
                    return requireDesktopRouter().open('reveal', undefined, request.params);
                case 'files.openWithDefaultApp':
                    // Restricted to files: handing a directory to the default application only reopens Finder, which
                    // `files.reveal` already does with a selection.
                    return requireDesktopRouter().open(
                        'openWithDefaultApp',
                        'file',
                        request.params,
                    );
                case 'project.openRoot':
                case 'project.openInEditor': {
                    if (request.method === 'project.openRoot')
                        return requireDesktopRouter().openProjectRoot(request.params);
                    return requireDesktopRouter().open('openInEditor', 'directory', request.params);
                }
                case 'host.stop': {
                    if (mutationAdmission.isClosed)
                        throw new CaxriError('CONFLICT', 'Host stop is already in progress');
                    mutationAdmission.close();
                    let isAccepted = false;
                    try {
                        await mutationAdmission.waitForDrain();
                        const health = await domainService.request('app.health');
                        if (health.activePtyCount > 0 && !request.params.confirmLivePtys)
                            throw new CaxriError(
                                'CONFLICT',
                                'Host has live PTYs; retry with explicit confirmation',
                            );
                        isAccepted = true;
                        /**
                         * Stop even if the requesting client disconnects before its reply can flush.
                         */
                        commandStopFallbackReference.current ??= setImmediate(async () => {
                            try {
                                await stop('command');
                            } catch (error) {
                                logger.write('error', logEventCatalog.serverCore.stopFailed, {
                                    fields: {
                                        message:
                                            error instanceof Error ? error.message : String(error),
                                    },
                                });
                            }
                        });
                        commandStopFallbackReference.current.unref();
                        return { stopping: true, activePtyCount: health.activePtyCount };
                    } finally {
                        if (!isAccepted) mutationAdmission.reopen();
                    }
                }
                case 'project.query': {
                    const endpoint =
                        context.principal.kind === 'agent'
                            ? agentEndpoints.context(context).endpoint
                            : undefined;
                    return domainService.request('project.queryForPrincipal', {
                        principal: context.principal,
                        query:
                            endpoint && request.params.mode === 'current'
                                ? { mode: 'show', selector: endpoint.projectId }
                                : request.params,
                    });
                }
                case 'session.query': {
                    const endpoint =
                        context.principal.kind === 'agent'
                            ? agentEndpoints.context(context).endpoint
                            : undefined;
                    return domainService.request('session.queryForPrincipal', {
                        principal: context.principal,
                        query:
                            endpoint && request.params.mode === 'current'
                                ? { mode: 'show', selector: endpoint.sessionId }
                                : request.params,
                    });
                }
                case 'terminal.query':
                    return domainService.request('terminal.queryForPrincipal', {
                        principal: context.principal,
                        query: request.params,
                    });
                case 'terminal.preview':
                    return forwardDomainOperation(request);
                case 'session.markRead':
                    return forwardDomainOperation(request);
                default: {
                    const forwarded: Extract<ServerRequest, { method: CoreForwardedMethod }> =
                        request;
                    const requestKey = principalRequestKey(context, invocation.requestId);
                    const durable = domainService.tryForwardDurableCommand(
                        forwarded,
                        invocation.requestId,
                        invocation.persistDurableResult
                            ? (result) => invocation.persistDurableResult!(result)
                            : undefined,
                        (task) => requestCancellations.run(requestKey, task),
                    );
                    if (durable) return durable.result;
                    return requestCancellations.run(requestKey, (signal) =>
                        forwardDomainOperation(forwarded, signal),
                    );
                }
            }
        },
    };

    try {
        await domainService.start();
        const protocolRecovery = await domainService.recoveryState();
        const protocolIdentity = protocolRecovery.identity();
        mobileAccess.attach(
            serverAdapter,
            lease.identity.processIdentity,
            protocolIdentity,
            domainService,
            terminalExecution,
            () => extensionService,
        );
        logger.updateBaseContext({ serverId: protocolIdentity.serverId });
        recoveryJournal.initialize(protocolIdentity, protocolRecovery);
        logger.write('info', logEventCatalog.serverCore.recoveryReady, {
            fields: { ...protocolRecovery.inspect() },
        });
        extensionService = await createExtensionService({
            appVersion: options.version,
            bootId: lease.identity.processIdentity,
            buildId: options.buildId ?? 'unknown',
            commit: options.commit,
            /**
             * The Extension Host only serves Desktop and Mobile view, tree, and command requests, so it starts when a
             * Desktop attaches (below) or on the first such request instead of at Core ready. Desktop attaches right
             * after Core is ready, so a local Desktop sees no difference; a Server only an operator, the CLI, or Agents
             * talk to (an SSH Host started before Desktop attaches) skips a resident Node process.
             */
            deferHostStart: true,
            desktopRouter: () => desktopRouter,
            domainService,
            executable: options.executable,
            extensionHostPath: options.extensionHostPath,
            extensionRoots: options.extensionRoots,
            includeTestExtensions: options.includeTestExtensions,
            logger,
            server: () => server,
            serverId: protocolIdentity.serverId,
            userDataPath: lease.paths.userDataPath,
        });
        idleExitConnections.bind(
            createIdleExitMonitor({
                ...(options.idleExitThresholdMs !== undefined && {
                    thresholdMs: options.idleExitThresholdMs,
                }),
                logger,
                isBusy: async () => (await domainService.request('app.health')).activePtyCount > 0,
                onIdleExit: ({ deferralCount, idleDurationMs }) => {
                    const reason: ServerIdleExitReason = 'idle-timeout';
                    logger.write('info', logEventCatalog.serverCore.idleExitTriggered, {
                        fields: { deferralCount, idleDurationMs, reason },
                    });
                    // eslint-disable-next-line no-void -- fire-and-forget shutdown from an internal timer callback
                    void stop(reason);
                },
            }),
        );
        server = new ControlServer({
            adapters: {
                durableReceipts: protocolRecovery,
                features: protocolFeatures,
                observeDurableReceipt: (observation) => logDurableReceipt(logger, observation),
                server: serverAdapter,
            },
            authenticateAgent: (credential) => agentEndpoints.authenticate(credential),
            authenticateDelegation: (credential) => delegationAccess.authenticate(credential),
            consumeDesktopTarget: (targetId, generation) => {
                if (!desktopRouter)
                    throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                return desktopRouter.consumeTarget(targetId, generation);
            },
            desktopCredential: lease.desktopCredential,
            invokeDesktopOperation: (request) =>
                request.method === 'mobile.device.revoke.apply'
                    ? mobileAccess.invokeDesktopOperation(request)
                    : forwardDomainOperation(request),
            logger,
            identity: lease.identity,
            protocolIdentity,
            onClientCountChanged: (clientCount, event) => {
                logger.recordMetric('connection.count', clientCount, {
                    owner: 'control',
                    phase: 'runtime',
                    outcome: 'success',
                });
                if (event === 'disconnected')
                    logger.recordMetric('connection.closed', 1, {
                        owner: 'control',
                        phase: 'shutdown',
                        outcome: 'success',
                    });
                logger.write('info', logEventCatalog.serverCore.clientCount, {
                    fields: { clientCount },
                });
                idleExitConnections.updateControlCount(clientCount);
            },
            onDesktopAttached: () => {
                // Starting is idempotent and logs its own failure; the handshake callback cannot await it.
                // eslint-disable-next-line no-void -- fire-and-forget Extension Host start on Desktop attach
                void extensionService?.startHost('desktop-attached');
            },
            ...createServerCoreControlCallbacks({
                agentEndpoints,
                agentInbox,
                commandStopFallbackReference,
                delegationAccess,
                dispatchWaitIds,
                domainService,
                logger,
                requestCancellations,
                stop,
            }),
        });
        desktopRouter = new ServerDesktopRouter({
            bridge: {
                invoke: (operation, expectedGeneration) =>
                    server!.invokeDesktop(operation, expectedGeneration),
                lease: () => server!.desktopLease(),
                ...(options.launchDesktop && { launch: options.launchDesktop }),
                waitForLease: (timeoutMs) => server!.waitForDesktopLease(timeoutMs),
            },
            domainService,
        });
        const endpoint = await server.start();
        await lease.publish(endpoint);
        logger.recordMetric('startup.phase', Date.now() - startedAt, {
            owner: 'server-core',
            phase: 'startup',
            outcome: 'success',
        });
        logger.write('info', logEventCatalog.serverCore.ready, {
            durationMs: Date.now() - startedAt,
            fields: { pid: process.pid, profileId: lease.identity.profileId },
        });
        return { lease, protocolIdentity, stopped, stopping, stop };
    } catch (error) {
        try {
            await stop('startup-failed');
        } catch {
            // Swallow: startup already failed, so report the original error, not the shutdown failure.
        }
        throw error;
    }
}

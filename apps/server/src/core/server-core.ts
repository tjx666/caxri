import process from 'node:process';

import type {
    CommandAdapter,
    ProtocolEventEnvelope,
    ServerEvent,
    ServerRequest,
} from '@caxri/protocol';
import {
    CaxriError,
    isServerRequest,
    isTransientServerEvent,
    projectObservableEventRecovery,
    protocolFeatures,
} from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import { warmServerExecutablePath } from '../domains/executables';
import { startServerObservability } from '../observability/server-observability';
import {
    agentCommandRequest,
    agentControlRequest,
    agentCurrentQuery,
    agentSecretRequest,
    agentSessionRequest,
    sessionImportRequest,
} from './agent-command-request';
import { createAgentEndpointControl } from './agent-endpoints/control';
import { AgentEndpointRegistry } from './agent-endpoints/registry';
import { sendAgentMessage } from './agent-message-send';
import { ControlServer } from './control-server';
import type { CoreForwardedMethod } from './core-methods';
import { createAgentMessaging } from './create-agent-messaging';
import { createServerDomainService } from './create-domain-service';
import { invokeDelegationAccess, isDelegationAccessRequest } from './delegation-access';
import { ServerDesktopRouter } from './desktop-router';
import { DispatchWaits } from './dispatch-waits';
import {
    invokeExtensionControlRequest,
    isExtensionControlRequest,
} from './extensions/control-requests';
import { createExtensionService } from './extensions/create-service';
import { createExtensionEventRouter } from './extensions/event-router';
import type { ExtensionService } from './extensions/service';
import {
    createDomainOperationForwarder,
    disconnectableForwarder,
} from './forward-domain-operation';
import { readHostStatus } from './host-status';
import { acceptHostStop } from './host-stop';
import { createIdleExitConnectionTracker, createIdleTimeoutMonitor } from './idle-exit';
import { isMobileControlRequest, resolveMobileAgentEndpoint } from './mobile';
import { MutationAdmission } from './mutation-admission';
import { assertOwnerOnlyMethod, projectScope } from './principal-project-scope';
import { acquireServerProfile } from './profile';
import { createServerRecoveryJournal, serverRecoverySnapshot } from './recovery-journal';
import {
    logDurableReceipt,
    logDurableRecovery,
    logRuntimeStatus,
    prepareServerEventForDelivery,
} from './recovery-observability';
import { principalRequestKey, RequestCancellationRegistry } from './request-cancellation';
import type { ServerCore, ServerCoreOptions } from './server-core-contract';
import type { CommandStopFallbackReference } from './server-core-control-callbacks';
import { createServerCoreControlCallbacks } from './server-core-control-callbacks';
import { runServerCoreStop } from './server-core-stop-steps';
import { createServerCredentialAccess } from './server-credential-access';
import { createTerminalExecution } from './terminal-host/create-execution';
import { invokeTerminalSend } from './terminal-send';
import { withRequestOrigin } from './with-request-origin';

export type { ServerCore, ServerCoreOptions } from './server-core-contract';
/**
 * Starts the profile owner, authenticated local transport, domain services, and Extension Host supervision.
 */
export async function startServerCore(options: ServerCoreOptions): Promise<ServerCore> {
    const startedAt = Date.now();
    const { eventLoopMonitor, logger } = startServerObservability(options);
    const detachExecutableLogger = warmServerExecutablePath(logger);
    const lease = await acquireServerProfile({
        logger,
        startedAt,
        userDataPath: options.userDataPath,
        version: options.version,
    });
    // Fed by `ControlServer` and `MobileGateway` below into one aggregate for `docs/adr/0010-server-core-idle-exit.md`.
    const idleExitConnections = createIdleExitConnectionTracker();
    let desktopRouter: ServerDesktopRouter | undefined;
    const credentials = createServerCredentialAccess({ desktopRouter: () => desktopRouter });
    logger.updateBaseContext({ bootId: lease.identity.processIdentity, buildId: options.buildId });
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
        hasMobileAttentionRecipient: credentials.hasAttentionRecipient,
        agentEndpointControl: endpointControl,
        agentHooksPath: options.agentHooksPath,
        createServices: options.createDomainServices,
        executable: options.executable,
        logger,
        searchWorkers: options.searchWorkers,
        terminalExecution,
        userDataPath: lease.paths.userDataPath,
    });
    let extensionService: ExtensionService | undefined;
    const requireDesktopRouter = (): ServerDesktopRouter => {
        if (!desktopRouter) throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
        return desktopRouter;
    };
    let stopPromise: Promise<void> | undefined;
    const commandStopFallbackReference: CommandStopFallbackReference = { current: undefined };
    const mutationAdmission = new MutationAdmission();
    const stoppedGate = Promise.withResolvers<void>();
    const stopped = stoppedGate.promise;
    // eslint-disable-next-line unicorn/prefer-await -- host.stop and idle exit never await `stopped`; avoid an unhandled rejection
    stopped.catch(() => {});
    const { promise: stopping, resolve: resolveStopping } = Promise.withResolvers<void>();
    const dispatchWaits = new DispatchWaits(domainService);
    const requestCancellations = new RequestCancellationRegistry();
    const forwardDomainOperation = createDomainOperationForwarder(
        domainService,
        mutationAdmission,
        agentEndpoints,
    );
    const forwardDisconnectable = disconnectableForwarder(
        requestCancellations,
        forwardDomainOperation,
    );
    const extensionEvents = createExtensionEventRouter({
        domainService,
        extensionService: () => extensionService,
        isStopping: () => stopPromise !== undefined,
        logger,
        watchesExtensionViews: credentials.watchesExtensionViews,
    });
    const recoveryJournal = createServerRecoveryJournal(
        serverRecoverySnapshot(domainService),
        (observation) => logDurableRecovery(logger, observation),
    );
    const deliver = (candidate: ServerEvent, persistedEnvelope?: ProtocolEventEnvelope): void => {
        const event = prepareServerEventForDelivery(logger, candidate);
        if (event.event === 'terminal.exit')
            agentEndpoints.retireTerminal(event.payload.terminalId);
        else if (event.event === 'runtime.status') logRuntimeStatus(logger, event.payload);
        extensionEvents.domainEvent(event);
        if (isTransientServerEvent(event)) server?.broadcast(event);
        else {
            const envelope = persistedEnvelope ?? recoveryJournal.publish(event);
            if (envelope) server?.broadcast(envelope);
        }
        credentials.publish(event);
    };
    domainService.onEvent(deliver);
    domainService.onActiveContextChanged(extensionEvents.activeContextChanged);
    const stop = (reason = 'requested'): Promise<void> => {
        mutationAdmission.close();
        resolveStopping();
        idleExitConnections.stop();
        // Lands even if Terminal Host exits (OS SIGTERM to the tree) before `domainService.shutdown()` runs below.
        terminalExecution.markCoreStopping?.();
        // Same race for the Extension Host, which is shut down last: its signal-driven exit must not restart it.
        extensionService?.markCoreStopping();
        stopPromise ??= (async () => {
            eventLoopMonitor.stop();
            detachExecutableLogger();
            try {
                // Captures every live Terminal's snapshot via `host.shutdown` first: the Extension Host's own graceful
                // shutdown can wait up to 5s for its child to exit, and under the previous ordering that delay let an
                // OS-initiated SIGTERM beat Core's `host.shutdown` request to Terminal Host.
                await runServerCoreStop(logger, reason, (run) => [
                    ['domainServices', () => domainService.shutdown(run)],
                    ['mobileAccess', () => credentials.close()],
                    ['controlServer', () => server?.close()],
                    ['agentInbox', () => agentInbox.close()],
                    ['providerMessaging', () => providerMessaging.close()],
                    ['extensionHost', () => extensionService?.shutdown()],
                    ['lease', () => lease.release()],
                ]);
            } catch (error) {
                // Always settles, so the process entrypoint finalizes and exits on host.stop and idle paths too.
                stoppedGate.reject(error);
                throw error;
            }
            stoppedGate.resolve();
        })();
        return stopPromise;
    };

    const serverAdapter: CommandAdapter = withRequestOrigin({
        async invoke(request, context, invocation) {
            if (!isServerRequest(request))
                throw new CaxriError(
                    'INTERNAL',
                    `Host received a desktop-owned method: ${request.method}`,
                );
            if (isMobileControlRequest(request))
                return credentials
                    .mobile()
                    .invokeControl(
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
                    credentials.delegation(),
                    forwardDomainOperation,
                );
            if (
                context.principal.kind === 'paired-device' &&
                (request.method === 'terminal.preview' || request.method === 'session.markRead')
            )
                await credentials
                    .mobile()
                    .validatePairedDeviceRequest(request, context, domainService);
            if (isExtensionControlRequest(request))
                return invokeExtensionControlRequest(request, extensionService, mutationAdmission);
            assertOwnerOnlyMethod(context, request.method);
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
                case 'agent.delegation.list':
                    return forwardDomainOperation(
                        agentCommandRequest(request, context, invocation.requestId, agentEndpoints),
                    );
                case 'agent.delegation.wait':
                    return forwardDisconnectable(
                        context,
                        invocation.requestId,
                        agentCommandRequest(request, context, invocation.requestId, agentEndpoints),
                    );
                case 'agent.dispatch.status':
                    return domainService.request('agent.dispatch.statusInternal', {
                        dispatchId: request.params.dispatchId,
                        projectScope: projectScope(context),
                    });
                case 'agent.dispatch.wait':
                    return dispatchWaits.wait(principalRequestKey(context, invocation.requestId), {
                        afterRevision: request.params.afterRevision,
                        dispatchId: request.params.dispatchId,
                        projectScope: projectScope(context),
                        timeoutMs: request.params.timeoutMs,
                    });
                case 'agent.control.interrupt':
                case 'agent.control.stop':
                    return forwardDomainOperation(
                        agentControlRequest(request, context, agentEndpoints, credentials.mobile()),
                    );
                case 'session.importConversation':
                    return forwardDomainOperation(sessionImportRequest(request, context));
                case 'agent.session.rename':
                case 'agent.session.archive':
                case 'agent.session.unarchive':
                    return forwardDomainOperation(
                        agentSessionRequest(request, context, agentEndpoints),
                    );
                case 'agent.secret.list':
                case 'agent.secret.request':
                case 'agent.secret.resolve':
                case 'agent.secret.wait': {
                    const operation = agentSecretRequest(request, context, agentEndpoints);
                    if (request.method !== 'agent.secret.wait')
                        return forwardDomainOperation(operation);
                    return forwardDisconnectable(context, invocation.requestId, operation);
                }
                case 'terminal.send':
                    return invokeTerminalSend({
                        invoke: () =>
                            forwardDomainOperation({
                                method: 'terminal.sendInternal',
                                params: request.params,
                            }),
                        logger,
                        parameters: request.params,
                        principalKind: context.principal.kind,
                    });
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
                case 'host.status':
                    return readHostStatus({
                        buildId: options.buildId,
                        clientCount: () => server?.clientCount() ?? 0,
                        desktopRouter: () => desktopRouter,
                        domainService,
                        profileId: lease.identity.profileId,
                        startedAt,
                        version: options.version,
                    });
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
                case 'host.stop':
                    return acceptHostStop(
                        {
                            commandStopFallbackReference,
                            domainService,
                            mutationAdmission,
                            stop,
                        },
                        request.params,
                    );
                case 'project.query':
                    return domainService.request('project.queryForPrincipal', {
                        principal: context.principal,
                        query: agentCurrentQuery(
                            request.params,
                            context,
                            agentEndpoints,
                            'projectId',
                        ),
                    });
                case 'session.query':
                    return domainService.request('session.queryForPrincipal', {
                        principal: context.principal,
                        query: agentCurrentQuery(
                            request.params,
                            context,
                            agentEndpoints,
                            'sessionId',
                        ),
                    });
                case 'terminal.query':
                    return domainService.request('terminal.queryForPrincipal', {
                        principal: context.principal,
                        query: request.params,
                    });
                case 'terminal.preview':
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
    });

    try {
        await domainService.start();
        const protocolRecovery = await domainService.recoveryState();
        const protocolIdentity = protocolRecovery.identity();
        await credentials.open(domainService, lease.paths.directory, {
            logger,
            ...(options.mobileHostDisplayName && {
                hostDisplayName: options.mobileHostDisplayName,
            }),
            onConnectionCountChanged: (count) => idleExitConnections.updateMobileCount(count),
            ...(options.mobileUpdateDirectory && {
                updateDirectory: options.mobileUpdateDirectory,
            }),
        });
        credentials
            .mobile()
            .attach(
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
            publishToMobile: credentials.publish,
            server: () => server,
            serverId: protocolIdentity.serverId,
            userDataPath: lease.paths.userDataPath,
        });
        server = new ControlServer({
            adapters: {
                durableReceipts: protocolRecovery,
                features: protocolFeatures,
                observeDurableReceipt: (observation) => logDurableReceipt(logger, observation),
                server: serverAdapter,
            },
            authenticateAgent: (credential) => agentEndpoints.authenticate(credential),
            authenticateDelegation: (credential) =>
                credentials.delegation().authenticate(credential),
            consumeDesktopTarget: (targetId, generation) => {
                if (!desktopRouter)
                    throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                return desktopRouter.consumeTarget(targetId, generation);
            },
            desktopCredential: lease.desktopCredential,
            invokeDesktopOperation: (request) =>
                request.method === 'mobile.device.revoke.apply'
                    ? credentials.mobile().invokeDesktopOperation(request)
                    : extensionEvents.routeDesktopOperation(request, forwardDomainOperation),
            logger,
            identity: lease.identity,
            protocolIdentity,
            onConnectionClosed: (connectionId) => domainService.onConnectionClosed(connectionId),
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
                void extensionService?.startHost('desktop-attached');
            },
            ...createServerCoreControlCallbacks({
                agentEndpoints,
                agentInbox,
                commandStopFallbackReference,
                delegationAccess: credentials.delegation(),
                dispatchWaits,
                domainService,
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
        // Armed after `publish`: an earlier idle stop released the lease, then `publish` left a stopped Core's manifest.
        idleExitConnections.bind(
            createIdleTimeoutMonitor({
                ...(options.idleExitThresholdMs !== undefined && {
                    thresholdMs: options.idleExitThresholdMs,
                }),
                logger,
                isBusy: async () => (await domainService.request('app.health')).activePtyCount > 0,
                stop,
            }),
        );
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

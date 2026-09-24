import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import process from 'node:process';

import type {
    CommandAdapter,
    ProtocolEventEnvelope,
    ServerEvent,
    ServerOperationRequest,
    ServerRequest,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    getMethodSpec,
    hasRequiredCapabilities,
    isServerRequest,
    isTransientServerEvent,
    projectObservableEventRecovery,
    protocolFeatures,
    resolveLogLevel,
} from '@caxri/protocol';
import { logEventCatalog, startEventLoopMonitor, StructuredLogger } from '@caxri/system';

import { createServerDomainService } from '../core/create-domain-service';
import { agentCommandRequest } from './agent-command-request';
import { createAgentEndpointControl } from './agent-endpoints/control';
import { AgentEndpointRegistry } from './agent-endpoints/registry';
import { retireEndpointsForOperation } from './agent-endpoints/retire-for-operation';
import { ControlServer } from './control-server';
import type { CoreForwardedMethod } from './core-methods';
import { createAgentMessaging } from './create-agent-messaging';
import {
    invokeDelegationAccess,
    isDelegationAccessRequest,
    openDelegationAccess,
} from './delegation-access';
import { ServerDesktopRouter } from './desktop-router';
import { createExtensionService } from './extensions/create-service';
import { readActiveExtensionContext, routeExtensionDomainEvent } from './extensions/domain-events';
import type { ExtensionService } from './extensions/service';
import { isMobileControlRequest, openMobileAccessController } from './mobile';
import { MutationAdmission } from './mutation-admission';
import { assertProjectScope, projectScope } from './principal-project-scope';
import { acquireServerProfile } from './profile';
import { createServerRecoveryJournal } from './recovery-journal';
import {
    logDurableReceipt,
    logDurableRecovery,
    prepareServerEventForDelivery,
} from './recovery-observability';
import {
    dispatchIdFor,
    principalRequestKey,
    RequestCancellationRegistry,
} from './request-cancellation';
import type { ServerCore, ServerCoreOptions } from './server-core-contract';
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
    const lease = await acquireServerProfile({
        startedAt,
        userDataPath: options.userDataPath,
        version: options.version,
    });
    const mobileAccess = await openMobileAccessController({
        directory: lease.paths.directory,
        ...(options.mobileHostDisplayName && { hostDisplayName: options.mobileHostDisplayName }),
        registryPath: lease.paths.mobileDevices,
        onOpenError: async () => {
            eventLoopMonitor.stop();
            await lease.release();
        },
    });
    logger.updateBaseContext({ bootId: lease.identity.processIdentity, buildId: options.buildId });
    const delegationAccess = await openDelegationAccess(lease.paths.directory, async () => {
        eventLoopMonitor.stop();
        await lease.release();
    });
    const agentEndpoints = new AgentEndpointRegistry(lease.identity.processIdentity);
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
    let stopPromise: Promise<void> | undefined;
    let commandStopFallback: NodeJS.Immediate | undefined;
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
    const recoverySnapshot = async (cursor: number) => {
        const state = await domainService.request('app.bootstrap');
        return {
            cursor,
            projectIds: state.projects.map(({ id }) => id),
            sessionIds: state.sessions.map(({ id }) => id),
            terminalIds: state.terminals.map(({ id }) => id),
            settingsRevision: cursor,
            diagnosticsRevision: cursor,
            agentRevision: cursor,
        };
    };
    const recoveryJournal = createServerRecoveryJournal(recoverySnapshot, (observation) =>
        logDurableRecovery(logger, observation),
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
            const extensionRefresh = routeExtensionDomainEvent(
                extensionService,
                domainService,
                event,
            );
            // eslint-disable-next-line unicorn/prefer-await -- event delivery cannot await a best-effort refresh
            extensionRefresh.catch((error: unknown) =>
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
    };
    domainService.onEvent(deliver);
    const stop = (reason = 'requested'): Promise<void> => {
        mutationAdmission.close();
        resolveStopping();
        // Lands even if Terminal Host exits (OS SIGTERM to the tree) before `domainService.shutdown()` runs below.
        terminalExecution.markCoreStopping?.();
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
                return mobileAccess.invokeControl(request, context, domainService);
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
            switch (request.method) {
                case 'events.recover':
                    return recoveryJournal.recover(request.params);
                case 'events.query':
                    return projectObservableEventRecovery(
                        await recoveryJournal.recover(request.params),
                    );
                case 'viewContainers.catalog':
                    if (!extensionService)
                        throw new CaxriError('UNAVAILABLE', 'Extension catalog is unavailable');
                    return extensionService.catalog();
                case 'viewContainers.treeChildren':
                    if (!extensionService)
                        throw new CaxriError('UNAVAILABLE', 'Extension Host is unavailable');
                    return extensionService.treeChildren(request.params);
                case 'viewContainers.viewOperation':
                    if (!extensionService)
                        throw new CaxriError('UNAVAILABLE', 'Extension Host is unavailable');
                    return extensionService.viewOperation(request.params);
                case 'viewContainers.executeCommand':
                    if (!extensionService)
                        throw new CaxriError('UNAVAILABLE', 'Extension Host is unavailable');
                    {
                        const context = await readActiveExtensionContext(domainService);
                        if (context.kind !== 'session')
                            throw new CaxriError(
                                'FORBIDDEN',
                                'Extension commands require an active Session',
                            );
                        return extensionService.executeCommand(
                            request.params.commandId,
                            request.params.arguments,
                            context,
                        );
                    }
                case 'viewContainers.cancelRequest':
                    return (
                        extensionService?.cancel(request.params.requestId) ?? {
                            cancelled: false,
                        }
                    );
                case 'requests.cancel':
                    return {
                        cancelled: requestCancellations.cancel(
                            principalRequestKey(context, request.params.requestId),
                        ),
                    };
                case 'extensions.retry':
                    if (!extensionService)
                        return {
                            accepted: false,
                            error: {
                                code: 'EXTENSION_HOST_UNAVAILABLE' as const,
                                message: 'Extension Host is unavailable',
                            },
                        };
                    return extensionService.retry(request.params.extensionId);
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
                    return requestCancellations.run(
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
                    const invoke = (signal?: AbortSignal) =>
                        forwardDomainOperation(
                            { method: 'terminal.sendInternal', params: request.params },
                            signal,
                        );
                    return invokeTerminalSend({
                        invoke,
                        invokePairedDevice: () =>
                            mobileAccess.invokeShortReply(
                                context,
                                request.params,
                                domainService,
                                invoke,
                            ),
                        logger,
                        parameters: request.params,
                        principalKind: context.principal.kind,
                    });
                }
                case 'agent.message.send': {
                    if (!request.params.wake)
                        return agentInbox.send(context, request.params, invocation.requestId);
                    if (!hasRequiredCapabilities(context, ['agents.dispatch', 'agents.control']))
                        throw new CaxriError(
                            'FORBIDDEN',
                            'Waking an Agent requires an agent:control grant',
                        );
                    let isTargetIsActive = true;
                    try {
                        agentEndpoints.resolve(request.params.to);
                    } catch {
                        isTargetIsActive = false;
                    }
                    if (isTargetIsActive)
                        return agentInbox.send(context, request.params, invocation.requestId);
                    /**
                     * Only an exact bounded tombstone can be promoted into a wake dispatch.
                     */
                    const retired = agentEndpoints.resolveRetired(request.params.to);
                    assertProjectScope(context, retired.projectId);
                    mutationAdmission.begin();
                    try {
                        const dispatch = await domainService.request(
                            'agent.dispatch.wakeInternal',
                            {
                                dispatchId: dispatchIdFor(context, invocation.requestId),
                                principal: context.principal,
                                target: {
                                    projectId: retired.projectId,
                                    sessionId: retired.sessionId,
                                    terminalId: retired.terminalId,
                                },
                            },
                        );
                        if (dispatch.status !== 'running' || !dispatch.endpoint)
                            throw new CaxriError('UNAVAILABLE', 'Agent wake dispatch failed', {
                                dispatchId: dispatch.dispatchId,
                                status: dispatch.status,
                            });
                        const current = agentEndpoints.resolveTerminal(retired.terminalId);
                        if (
                            current.ref.endpointId !== dispatch.endpoint.endpointId ||
                            current.ref.generation !== dispatch.endpoint.generation
                        )
                            throw new CaxriError(
                                'UNAVAILABLE',
                                'Agent generation changed after wake dispatch',
                                { dispatchId: dispatch.dispatchId },
                            );
                        return agentInbox.send(
                            context,
                            {
                                body: request.params.body,
                                to: current.ref,
                                ttlMs: request.params.ttlMs,
                                ...(request.params.idempotencyKey && {
                                    idempotencyKey: request.params.idempotencyKey,
                                }),
                            },
                            invocation.requestId,
                            dispatch.dispatchId,
                        );
                    } finally {
                        mutationAdmission.finish();
                    }
                }
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
                case 'desktop.focus': {
                    if (!desktopRouter)
                        throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                    return desktopRouter.focus(request.params.launchIfNeeded);
                }
                case 'desktop.openPath':
                case 'desktop.openProject':
                case 'desktop.openFile': {
                    if (!desktopRouter)
                        throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                    const kind =
                        request.method === 'desktop.openPath'
                            ? undefined
                            : request.method === 'desktop.openFile'
                              ? 'file'
                              : 'directory';
                    return desktopRouter.open('open', kind, request.params);
                }
                case 'files.reveal':
                    if (!desktopRouter)
                        throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                    return desktopRouter.open('reveal', undefined, request.params);
                case 'files.openWithDefaultApp':
                    if (!desktopRouter)
                        throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                    // Restricted to files: handing a directory to the default application only reopens Finder, which
                    // `files.reveal` already does with a selection.
                    return desktopRouter.open('openWithDefaultApp', 'file', request.params);
                case 'project.openRoot':
                case 'project.openInEditor': {
                    if (!desktopRouter)
                        throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                    if (request.method === 'project.openRoot')
                        return desktopRouter.openProjectRoot(request.params);
                    return desktopRouter.open('openInEditor', 'directory', request.params);
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
                        commandStopFallback ??= setImmediate(async () => {
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
                        commandStopFallback.unref();
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
        mobileAccess.attach(serverAdapter, lease.identity.processIdentity, protocolIdentity);
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
            },
            onDesktopUnavailable: async () => {
                try {
                    await domainService.request('terminal.detachAll');
                } catch {
                    // Best-effort detach: domain services already report Desktop as unavailable.
                }
            },
            onReplyFlushed: async (request, reply, context) => {
                if (
                    request.method === 'agent.message.wait' ||
                    request.method === 'agent.message.check'
                ) {
                    if (reply.ok) agentInbox.confirmWait(request.id, context);
                    else agentInbox.cancelWait(request.id);
                }
                if (request.method === 'host.stop' && reply.ok) {
                    if (commandStopFallback) clearImmediate(commandStopFallback);
                    commandStopFallback = undefined;
                    try {
                        await stop('command');
                    } catch (error) {
                        logger.write('error', logEventCatalog.serverCore.stopFailed, {
                            fields: {
                                message: error instanceof Error ? error.message : String(error),
                            },
                        });
                    }
                }
            },
            onRequestDisconnected: async (requestId, context) => {
                agentInbox.cancelWait(requestId);
                const waitIds =
                    dispatchWaitIds.get(principalRequestKey(context, requestId)) ??
                    new Set<string>();
                await Promise.all(
                    [...waitIds].map(async (waitId) => {
                        try {
                            await domainService.request('agent.dispatch.cancelWaitInternal', {
                                waitId,
                            });
                        } catch {
                            // Best-effort cancel: the wait may have already resolved.
                        }
                    }),
                );
            },
            refreshContext: (context) =>
                context.principal.kind === 'delegation-client'
                    ? delegationAccess.refresh(context.principal)
                    : agentEndpoints.refresh(context),
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

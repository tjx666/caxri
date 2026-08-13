import { join } from 'node:path';

import type { CommandAdapter } from '../shared/ipc/dispatcher';
import { CaxriError } from '../shared/ipc/errors';
import {
    createEventJournal,
    isTransientRuntimeEvent,
    projectObservableEventRecovery,
} from '../shared/ipc/event-journal';
import type { RuntimeEvent } from '../shared/ipc/events';
import { getMethodSpec, type RuntimeRequest } from '../shared/ipc/methods';
import { CAXRI_PROTOCOL_VERSION } from '../shared/ipc/version';
import { StructuredLogger } from '../shared/node/logger';
import { LocalHostServer } from './local-server';
import { HostDesktopRouter } from './desktop-router';
import { acquireHostProfile, type HostProfileLease } from './profile';
import { HostRuntimeSupervisor } from './runtime-supervisor';

export interface HostApplicationOptions {
    agentHooksPath?: string;
    commit: string;
    executable?: string;
    launchDesktop?: () => Promise<void>;
    runtimePath: string;
    runtimeEnvironment?: NodeJS.ProcessEnv;
    socketDirectory?: string;
    userDataPath: string;
    version: string;
}

export interface HostApplication {
    lease: HostProfileLease;
    stop(reason?: string): Promise<void>;
}

/** Starts the profile owner, authenticated local transport, and its sole Runtime child. */
export async function startHostApplication(
    options: HostApplicationOptions,
): Promise<HostApplication> {
    const startedAt = Date.now();
    const logDirectory = join(options.userDataPath, 'logs');
    const logger = new StructuredLogger(logDirectory, 'host', 'info');
    const lease = await acquireHostProfile({
        socketDirectory: options.socketDirectory,
        startedAt,
        userDataPath: options.userDataPath,
        version: options.version,
    });
    const supervisor = new HostRuntimeSupervisor({
        agentHooksPath: options.agentHooksPath,
        appVersion: options.version,
        commit: options.commit,
        executable: options.executable,
        extraEnvironment: options.runtimeEnvironment,
        logDirectory,
        logger,
        runtimePath: options.runtimePath,
        userDataPath: lease.paths.userDataPath,
    });
    let server: LocalHostServer | undefined;
    let desktopRouter: HostDesktopRouter | undefined;
    let stopPromise: Promise<void> | undefined;
    let commandStopFallback: NodeJS.Immediate | undefined;
    let mutationAdmissionClosed = false;
    let mutationsInFlight = 0;
    const mutationDrainWaiters = new Set<() => void>();

    const finishMutation = (): void => {
        mutationsInFlight -= 1;
        if (mutationsInFlight !== 0) return;
        for (const resolve of mutationDrainWaiters) resolve();
        mutationDrainWaiters.clear();
    };
    const waitForMutations = (): Promise<void> =>
        mutationsInFlight === 0
            ? Promise.resolve()
            : new Promise((resolve) => mutationDrainWaiters.add(resolve));

    const forwardRuntime = async (request: RuntimeRequest): Promise<unknown> => {
        const spec = getMethodSpec(request.method);
        if (!spec) throw new CaxriError('VALIDATION', 'Unknown Runtime command');
        if (spec.effect === 'read') return supervisor.forward(request.method, request.params);
        if (mutationAdmissionClosed) throw new CaxriError('UNAVAILABLE', 'Host is stopping');
        mutationsInFlight += 1;
        try {
            return await supervisor.forward(request.method, request.params);
        } finally {
            finishMutation();
        }
    };

    const journal = createEventJournal({
        snapshot: async (cursor) => {
            const state = await supervisor.request('app.bootstrap');
            return {
                cursor,
                projectIds: state.projects.map(({ id }) => id),
                sessionIds: state.sessions.map(({ id }) => id),
                terminalIds: state.terminals.map(({ id }) => id),
                settingsRevision: cursor,
                diagnosticsRevision: cursor,
                agentRevision: cursor,
            };
        },
    });

    const deliver = (event: RuntimeEvent): void => {
        if (event.event === 'runtime.status')
            logger.write(event.payload.status === 'failed' ? 'error' : 'info', 'runtime.status', {
                fields: {
                    status: event.payload.status,
                    restartCount: event.payload.restartCount,
                },
            });
        server?.broadcast(isTransientRuntimeEvent(event) ? event : journal.publish(event));
    };
    supervisor.on('event', deliver);

    const stop = (reason = 'requested'): Promise<void> => {
        mutationAdmissionClosed = true;
        stopPromise ??= (async () => {
            logger.write('info', 'host.stopping', { fields: { reason } });
            await server?.close();
            await supervisor.shutdown();
            await lease.release();
            logger.write('info', 'host.stopped', { fields: { reason } });
        })();
        return stopPromise;
    };

    const host: CommandAdapter = {
        async invoke(request, context) {
            if (request.method === 'events.recover')
                return journal.recover(request.params.afterCursor);
            if (request.method === 'events.query')
                return projectObservableEventRecovery(
                    await journal.recover(request.params.afterCursor),
                );
            if (request.method === 'host.status') {
                const health = await supervisor.request('app.health');
                return {
                    profileId: lease.manifest.profileId,
                    version: options.version,
                    pid: process.pid,
                    ...(supervisor.processId() ? { runtimePid: supervisor.processId() } : {}),
                    startedAt,
                    clientCount: server?.clientCount() ?? 0,
                    activePtyCount: health.activePtyCount,
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    protocolCompatible: true,
                    desktop: (await desktopRouter?.status()) ?? { state: 'offline' },
                };
            }
            if (request.method === 'desktop.status')
                return (await desktopRouter?.status()) ?? { state: 'offline' };
            if (request.method === 'desktop.focus') {
                if (!desktopRouter)
                    throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                return desktopRouter.focus(request.params.launchIfNeeded);
            }
            if (request.method === 'desktop.openProject') {
                if (!desktopRouter)
                    throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                return desktopRouter.open('open', 'directory', request.params);
            }
            if (request.method === 'desktop.openFile') {
                if (!desktopRouter)
                    throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                return desktopRouter.open('open', 'file', request.params);
            }
            if (request.method === 'files.reveal') {
                if (!desktopRouter)
                    throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                return desktopRouter.open('reveal', undefined, request.params);
            }
            if (request.method === 'host.stop') {
                if (mutationAdmissionClosed)
                    throw new CaxriError('CONFLICT', 'Host stop is already in progress');
                mutationAdmissionClosed = true;
                let accepted = false;
                try {
                    await waitForMutations();
                    const health = await supervisor.request('app.health');
                    if (health.activePtyCount > 0 && !request.params.confirmLivePtys)
                        throw new CaxriError(
                            'CONFLICT',
                            'Host has live PTYs; retry with explicit confirmation',
                        );
                    accepted = true;
                    /** Stop even if the requesting client disconnects before its reply can flush. */
                    commandStopFallback ??= setImmediate(() => void stop('command'));
                    commandStopFallback.unref();
                    return { stopping: true, activePtyCount: health.activePtyCount };
                } finally {
                    if (!accepted) mutationAdmissionClosed = false;
                }
            }
            if (request.method === 'project.query')
                return supervisor.request('project.queryForPrincipal', {
                    principal: context.principal,
                    query: request.params,
                });
            if (request.method === 'session.query')
                return supervisor.request('session.queryForPrincipal', {
                    principal: context.principal,
                    query: request.params,
                });
            if (request.method === 'terminal.query')
                return supervisor.request('terminal.queryForPrincipal', {
                    principal: context.principal,
                    query: request.params,
                });
            return forwardRuntime(request);
        },
    };

    try {
        await supervisor.start();
        server = new LocalHostServer({
            adapters: { host },
            consumeDesktopTarget: (targetId, generation) => {
                if (!desktopRouter)
                    throw new CaxriError('UNAVAILABLE', 'Desktop routing is unavailable');
                return desktopRouter.consumeTarget(targetId, generation);
            },
            desktopCredential: lease.desktopCredential,
            invokeDesktopRuntime: (request) => forwardRuntime(request),
            manifest: lease.manifest,
            onClientCountChanged: (clientCount) =>
                logger.write('info', 'host.client_count', { fields: { clientCount } }),
            onDesktopUnavailable: () => {
                void supervisor.request('terminal.detachAll').catch(() => undefined);
            },
            onReplyFlushed: (request, reply) => {
                if (request.method !== 'host.stop' || !reply.ok) return;
                if (commandStopFallback) clearImmediate(commandStopFallback);
                commandStopFallback = undefined;
                void stop('command');
            },
        });
        desktopRouter = new HostDesktopRouter({
            bridge: {
                invoke: (operation, expectedGeneration) =>
                    server!.invokeDesktop(operation, expectedGeneration),
                lease: () => server!.desktopLease(),
                ...(options.launchDesktop ? { launch: options.launchDesktop } : {}),
                waitForLease: (timeoutMs) => server!.waitForDesktopLease(timeoutMs),
            },
            runtime: supervisor,
        });
        await server.start();
        await lease.publish();
        logger.write('info', 'host.ready', {
            durationMs: Date.now() - startedAt,
            fields: { pid: process.pid, profileId: lease.manifest.profileId },
        });
        return { lease, stop };
    } catch (error) {
        await stop('startup-failed').catch(() => undefined);
        throw error;
    }
}

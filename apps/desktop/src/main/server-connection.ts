import type { RecoveringEventClient, ServerConnectionState } from '@caxri/client';
import {
    createRecoveringEventClient,
    initialServerConnectionState,
    reconnectContext,
    transitionServerConnection,
} from '@caxri/client';
import type {
    ServerClient,
    ServerLaunchOptions,
    ServerSupervisionEvent,
} from '@caxri/client/supervise';
import { resolveServerArtifact, ServerArtifactSupervisor } from '@caxri/client/supervise';
import type {
    CaxriMethod,
    DesktopLeaseRevocationReason,
    ServerEvent,
    ServerOperation,
    ServerOperationArguments,
    ServerOperationResult,
} from '@caxri/protocol';
import { CaxriError, errorMessage, isCaxriMethod, isDesktopServerOperation } from '@caxri/protocol';
import { computeBuildFingerprint, logEventCatalog } from '@caxri/system';

import { desktopCommandCallbackError } from './desktop-command-scope';
import { ReconnectBackoff, RECOVERY_WINDOW_MS } from './reconnect-backoff';
import type { DesktopServerConnectionOptions, DesktopServerSupervisor } from './server-attachment';
import { connectDesktopAttachment, waitForServerExit } from './server-attachment';
import { buildServerLaunchEnvironment } from './server-launch-environment';
import type { ServerBuildIdentity } from './server-staleness';
import { isServerBuildStale } from './server-staleness';

interface UntypedServerClient {
    request(method: CaxriMethod, parameters?: unknown): Promise<unknown>;
    requestServerOperation(
        method: ServerOperation,
        parameters?: unknown,
        timeoutMs?: number,
    ): Promise<unknown>;
    requestWithId(id: string, method: CaxriMethod, parameters?: unknown): Promise<unknown>;
}

/**
 * Desktop-side client facade for typed Server operations and recovery.
 */
export class DesktopServerConnection extends EventTarget {
    private client?: ServerClient;
    private events?: RecoveringEventClient;
    private eventsRecoveryIdentity?: string;
    private eventsServerBootIdentity?: string;
    private serverPid?: number;
    private starting?: Promise<void>;
    private reconnectTask?: Promise<void>;
    private readonly backoff = new ReconnectBackoff();
    private lifecycle: ServerConnectionState = initialServerConnectionState;
    /**
     * Once this connection has replaced one stale Server, further mismatches only warn. Without this instance-level
     * guard, every background reconnect (`reconnectUntilAttached` → `connect`) restarts the replacement from scratch,
     * and a persistent mismatch (e.g. two Desktops of different builds sharing one Server) becomes a kill/spawn storm.
     */
    private hasReplacedStaleServer = false;
    private isCoreRecoveryPending = false;
    /**
     * Set by {@link markQuitting} once Main has accepted a quit. Quit teardown still needs this attachment for its
     * best-effort window-state and detach requests, so it is not disposed yet, but a connection loss from then on is
     * the expected end of the Server rather than an outage to recover from.
     */
    private isQuitting = false;
    private readonly serverSupervisor: DesktopServerSupervisor;
    private readonly unsubscribeServerLifecycle: () => void;

    constructor(private readonly options: DesktopServerConnectionOptions) {
        super();
        const launchOptions = this.serverLaunchOptions();
        this.serverSupervisor = options.createServerSupervisor
            ? options.createServerSupervisor(options.userDataPath, launchOptions)
            : new ServerArtifactSupervisor(options.userDataPath, launchOptions);
        this.unsubscribeServerLifecycle = this.serverSupervisor.onLifecycle((event) =>
            this.handleServerLifecycle(event),
        );
    }

    private serverLaunchOptions(): ServerLaunchOptions {
        return {
            artifactRoot: this.options.serverArtifactRoot,
            environment: buildServerLaunchEnvironment({
                agentHooksPath: this.options.agentHooksPath,
                cliPath: this.options.cliPath,
                desktopLaunch: this.options.desktopLaunch,
                e2eAgentPolicy: this.options.e2eAgentPolicy,
            }),
        };
    }

    private handleServerLifecycle(event: ServerSupervisionEvent): void {
        this.isCoreRecoveryPending = event.status === 'restarting';
        this.dispatchEvent(
            new CustomEvent<ServerEvent>('event', {
                detail: {
                    event: 'runtime.status',
                    payload: {
                        status: event.status,
                        restartCount: event.restartCount,
                    },
                },
            }),
        );
    }

    private async connect(): Promise<'same' | 'replaced'> {
        let serverIdentity = await this.attachToCurrentServer();
        serverIdentity ??= await this.attachToCurrentServer(true);
        if (serverIdentity === undefined)
            throw new CaxriError('UNAVAILABLE', 'Replacement Caxri Host still reports stale code');
        const client = await connectDesktopAttachment(this.options);
        this.client = client;
        client.onClose((reason, closeCode) => this.handleConnectionLoss(client, reason, closeCode));
        const connectionIdentity = client.welcome.connection;
        const recoveryIdentity = connectionIdentity
            ? `${connectionIdentity.serverId}:${connectionIdentity.stateEpoch}`
            : serverIdentity;
        const isServerReplaced =
            this.eventsServerBootIdentity !== undefined &&
            this.eventsServerBootIdentity !== serverIdentity;
        // A normal Server restart keeps its durable history, so retain the consumed cursor across Boot IDs. A different
        // Server ID or State Epoch replaces the recovery client and starts from a bounded snapshot/cursor zero.
        if (!this.events || this.eventsRecoveryIdentity !== recoveryIdentity) {
            this.events = createRecoveringEventClient({
                emit: (event) => {
                    this.dispatchEvent(new CustomEvent<ServerEvent>('event', { detail: event }));
                },
                ...(connectionIdentity && {
                    identity: {
                        serverId: connectionIdentity.serverId,
                        stateEpoch: connectionIdentity.stateEpoch,
                    },
                }),
                onError: (error) =>
                    this.options.logger.write(
                        'error',
                        logEventCatalog.serverConnection.eventRecoveryFailed,
                        {
                            fields: {
                                error:
                                    error instanceof Error
                                        ? error.message
                                        : 'Unknown recovery error',
                            },
                        },
                    ),
                // Resolved per call so recovery always targets the currently attached client
                // instead of a connection that has since been lost.
                recover: (afterCursor) => {
                    const attached = this.client;
                    if (!attached) return Promise.reject(this.disconnectedRequestError());
                    const identity = attached.welcome.connection;
                    return attached.request('events.recover', {
                        afterCursor,
                        ...(identity && {
                            serverId: identity.serverId,
                            stateEpoch: identity.stateEpoch,
                        }),
                    });
                },
            });
            this.eventsRecoveryIdentity = recoveryIdentity;
        }
        this.eventsServerBootIdentity = serverIdentity;
        const events = this.events;
        client.onEvent((event) => events.receive(event));
        await events.start();
        if (this.client === client) this.isCoreRecoveryPending = false;
        return isServerReplaced ? 'replaced' : 'same';
    }

    private async attach(): Promise<void> {
        try {
            const serverContinuity = await this.connect();
            this.lifecycle = transitionServerConnection(this.lifecycle, {
                type: 'attachment-succeeded',
                serverContinuity,
            });
        } catch (error) {
            this.lifecycle = transitionServerConnection(this.lifecycle, {
                type: 'attachment-failed',
            });
            throw error;
        }
    }

    /**
     * Ensures a Server is running and vets its build before serving it. A stale Server (older build than this Desktop)
     * is stopped and `undefined` is returned so the caller can ensure a fresh one. Replacement happens at most once per
     * connection instance (`hasReplacedStaleServer`) and never on the final attempt of a connect, so a persistent
     * mismatch (including two ping-ponging Desktops of different builds) degrades to a logged warning instead of an
     * endless kill/spawn loop.
     */
    private async attachToCurrentServer(isFinalAttempt = false): Promise<string | undefined> {
        // Recomputed per attempt: a watch rebuild may have replaced the bundles since the last connect, and the
        // freshly spawned replacement Server reads the same bytes, so both sides agree by construction.
        const artifact = await resolveServerArtifact(this.options.serverArtifactRoot);
        const desktopBuildId = await (this.options.computeBuildId ?? computeBuildFingerprint)(
            artifact.bundleDirectory,
        );
        const buildIdentity: ServerBuildIdentity = {
            ...this.options.buildIdentity,
            buildId: desktopBuildId,
        };
        const operator = await this.serverSupervisor.ensure();
        try {
            const status = await operator.request('host.status');
            const skewFields = {
                desktopBuildId: buildIdentity.buildId ?? 'unknown',
                desktopCommit: buildIdentity.commit ?? 'unknown',
                desktopVersion: buildIdentity.version ?? 'unknown',
                hostBuildId: status.buildId ?? 'unknown',
                hostCommit: status.commit ?? 'unknown',
                serverPid: status.pid,
                hostVersion: status.version,
            };
            if (isServerBuildStale(buildIdentity, status)) {
                if (isFinalAttempt || this.hasReplacedStaleServer) {
                    this.options.logger.write(
                        'warn',
                        logEventCatalog.serverConnection.versionMismatch,
                        {
                            fields: skewFields,
                        },
                    );
                } else {
                    /**
                     * Live PTYs die with the stale Server, which is the intended trade: silently serving Terminals from
                     * an older build is the failure mode this replaces.
                     */
                    this.options.logger.write(
                        'warn',
                        logEventCatalog.serverConnection.staleBuildReplaced,
                        {
                            fields: skewFields,
                        },
                    );
                    this.hasReplacedStaleServer = true;
                    await operator.request('host.stop', { confirmLivePtys: true });
                    this.serverSupervisor.releaseProcess(status.pid);
                    await waitForServerExit(this.serverSupervisor, status.pid);
                    return undefined;
                }
            }
            this.serverPid = status.pid;
            return `${status.pid}:${status.startedAt}`;
        } finally {
            operator.close();
        }
    }

    /**
     * Drops a lost attachment and keeps retrying recoverable outages in the background. An orderly same-profile Desktop
     * takeover is terminal for this Main instance so it cannot evict the replacement in return.
     */
    private handleConnectionLoss(
        lost: ServerClient,
        reason?: DesktopLeaseRevocationReason,
        closeCode?: number,
    ): void {
        if (this.lifecycle.status === 'disposed' || this.client !== lost) return;
        this.client = undefined;
        this.starting = undefined;
        this.lifecycle = transitionServerConnection(this.lifecycle, {
            type: 'connection-lost',
            atMs: Date.now(),
            reason: reason === 'replaced' ? 'replaced' : 'transport',
        });
        if (reason === 'replaced') {
            this.options.logger.write(
                'warn',
                logEventCatalog.serverConnection.desktopLeaseReplaced,
                {},
            );
            this.dispatchEvent(
                new CustomEvent<ServerEvent>('event', {
                    detail: {
                        event: 'host.connectionChanged',
                        payload: { status: 'replaced' },
                    },
                }),
            );
            return;
        }
        if (this.isQuitting) {
            this.options.logger.write('info', logEventCatalog.serverConnection.connectionLost, {
                fields: { closeCode: closeCode ?? null, source: 'desktop-quitting' },
            });
            this.disposeLifecycle();
            return;
        }
        this.options.logger.write('warn', logEventCatalog.serverConnection.connectionLost, {
            fields: { closeCode: closeCode ?? null },
        });
        if (this.serverPid !== undefined) this.serverSupervisor.reportProcessLoss(this.serverPid);
        if (this.serverSupervisor.isFailed()) return;
        this.ensureReconnectLoop();
    }

    /**
     * Owns the single reconnect-loop task. The task handle is an I/O deduplication seam, while every lifecycle decision
     * remains in the pure state machine.
     */
    private ensureReconnectLoop(): void {
        if (this.reconnectTask) return;
        const task = this.reconnectUntilAttached();
        this.reconnectTask = task;
        // The loop handles attempt failures internally; this finalizer only releases the task ownership.
        // eslint-disable-next-line no-void
        void task.finally(() => {
            if (this.reconnectTask === task) this.reconnectTask = undefined;
        });
    }

    private async reconnectUntilAttached(): Promise<void> {
        while (this.lifecycle.status === 'backoff') {
            const waiting = this.lifecycle;
            const { attempt, outageStartedAtMs } = waiting;
            const backoffMs = this.isCoreRecoveryPending
                ? 0
                : Math.min(500 * 2 ** (attempt - 1), 10_000);
            // eslint-disable-next-line no-await-in-loop -- sequential backoff between retries.
            await this.backoff.wait(backoffMs);
            if (this.lifecycle !== waiting) continue;
            this.lifecycle = transitionServerConnection(this.lifecycle, {
                type: 'backoff-elapsed',
            });
            try {
                // eslint-disable-next-line no-await-in-loop -- each attempt must settle before the next backoff.
                await this.start();
            } catch (error) {
                this.options.logger.write(
                    'warn',
                    logEventCatalog.serverConnection.reconnectFailed,
                    {
                        fields: { attempt, error: errorMessage(error, 'unknown') },
                    },
                );
                if (this.serverSupervisor.isFailed()) return;
                continue;
            }
            if (this.lifecycle.status !== 'recovering') {
                if (this.lifecycle.status === 'backoff') continue;
                return;
            }
            const recovering = this.lifecycle;
            const downtimeMs = Date.now() - outageStartedAtMs;
            const isServerReplaced = recovering.serverContinuity === 'replaced';
            this.options.logger.write('info', logEventCatalog.serverConnection.reconnected, {
                fields: { attempt, downtimeMs, isHostReplaced: isServerReplaced },
            });
            // Re-announce Renderer readiness so the replacement Server resumes delivering
            // one-shot window commands without waiting for another boot.
            if (recovering.readiness === 'announced')
                try {
                    // eslint-disable-next-line no-await-in-loop -- final readiness barrier for this attempt.
                    await this.markDesktopReady();
                    /**
                     * `desktop.ready` and this recovery command share Server's ordered control queue. The recovery
                     * reply is therefore a readiness barrier: it includes every durable event journaled after the first
                     * reconnect recovery and before ready became active, without adding an initial-startup round trip.
                     */
                    // eslint-disable-next-line no-await-in-loop -- ordered readiness barrier for this attempt.
                    await this.events?.start();
                } catch (error) {
                    this.options.logger.write(
                        'error',
                        logEventCatalog.serverConnection.desktopReadyFailed,
                        {
                            fields: { error: errorMessage(error, 'unknown') },
                        },
                    );
                }
            // The replacement connection can be lost again while this loop is still finishing,
            // so a backoff state here means "keep retrying", not success.
            if (!this.client) continue;
            this.lifecycle = transitionServerConnection(this.lifecycle, {
                type: 'recovery-completed',
            });
            /**
             * Transient events (PTY bytes above all) sent during the outage were dropped without replay, so the
             * Renderer must re-attach mounted Terminal panes; durable-event recovery alone cannot restore them.
             */
            this.dispatchEvent(
                new CustomEvent<ServerEvent>('event', {
                    detail: {
                        event: 'host.connectionChanged',
                        payload: {
                            status: 'reconnected',
                            downtimeMs,
                            attempt,
                            isHostReplaced: isServerReplaced,
                        },
                    },
                }),
            );
            return;
        }
    }

    private disconnectedRequestError(): CaxriError {
        /**
         * Replacement and disposal are terminal Desktop lifecycles: queued Renderer work is abandoned intentionally. A
         * recoverable socket outage remains UNAVAILABLE so normal reconnect behavior is unchanged.
         */
        return this.lifecycle.status === 'replaced' || this.lifecycle.status === 'disposed'
            ? new CaxriError('CANCELLED', 'Desktop Host connection is no longer active')
            : new CaxriError('UNAVAILABLE', 'Desktop is not connected to the Caxri Host');
    }

    private disposeLifecycle(): void {
        if (this.lifecycle.status !== 'disposed')
            this.lifecycle = transitionServerConnection(this.lifecycle, { type: 'dispose' });
        // Disposal is terminal, so no in-flight or queued durable-event recovery may outlive it.
        this.events?.stop();
        this.unsubscribeServerLifecycle();
    }

    /**
     * True while a request may fail with `UNAVAILABLE` purely because the connection is between attachments and the
     * reconnect loop still owns recovery. `idle` is excluded because nothing retries after a failed initial attachment,
     * and a failed supervisor is excluded because the loop has stopped re-arming (see `ensureReconnectLoop`); both are
     * real outages a caller must be told about. `replaced` and `disposed` never reach here; they answer `CANCELLED`.
     * The first attachment is excluded through {@link reconnectContext}: it shares the `attaching` status but owns no
     * outage, so a failure there is not a reconnect.
     *
     * A failed supervisor is not the only permanent outage. `ServerArtifactSupervisor.ensure` throws `CONFLICT` without
     * touching the restart budget when the Server process is alive but its authenticated endpoint keeps refusing, so
     * `isFailed()` never becomes true and the loop retries forever. Bounding the window by outage age is what keeps
     * that case reported as a fault instead of an endless reconnect.
     */
    isRecovering(): boolean {
        if (this.serverSupervisor.isFailed()) return false;
        const context = reconnectContext(this.lifecycle);
        if (context === undefined) return false;
        return Date.now() - context.outageStartedAtMs < RECOVERY_WINDOW_MS;
    }

    serverProcessId(): number | undefined {
        return this.serverPid;
    }

    /**
     * Ends the reconnect loop's current backoff wait so the next attempt starts now, for a user who knows the network
     * is back. Returns whether a wait was pending; during an attempt, or with no outage, it does nothing.
     */
    retryNow(): boolean {
        return this.backoff.wake();
    }

    start(): Promise<void> {
        if (this.lifecycle.status === 'replaced')
            return Promise.reject(
                new CaxriError(
                    'CONFLICT',
                    'Another Caxri window replaced this Desktop profile lease',
                ),
            );
        if (this.lifecycle.status === 'disposed') return Promise.resolve();
        this.lifecycle = transitionServerConnection(this.lifecycle, { type: 'start' });
        const starting = this.starting ?? this.attach();
        this.starting = starting;
        // `start()` returns the in-flight connection promise synchronously; resetting
        // `this.starting` on failure so a later caller can retry is deliberately
        // fire-and-forget here rather than awaited.
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        starting.catch(() => {
            if (this.starting === starting) this.starting = undefined;
        });
        return starting;
    }

    /**
     * Retries after the supervisor stopped on its own: an initial attachment that failed returns to `idle`, and a
     * reconnect loop exits once the supervisor reports `isFailed()`. An SSH Host supervisor does that when OpenSSH
     * needs the user (a password or a changed host key), so the user's Reconnect has to re-arm whichever attempt
     * stopped. It is also the only way back from a lease another Desktop replaced: the reconnect loop then takes it
     * back.
     */
    resume(): Promise<void> {
        if (this.lifecycle.status === 'idle') return this.start();
        this.lifecycle = transitionServerConnection(this.lifecycle, {
            type: 'reclaim',
            atMs: Date.now(),
        });
        if (this.lifecycle.status === 'backoff') {
            this.ensureReconnectLoop();
            return this.reconnectTask ?? Promise.resolve();
        }
        return this.starting ?? Promise.resolve();
    }

    /**
     * Subscribes to Server protocol events; returns an unsubscribe function.
     */
    onEvent(listener: (event: ServerEvent) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<ServerEvent>).detail);
        this.addEventListener('event', handler);
        return () => this.removeEventListener('event', handler);
    }

    request<M extends ServerOperation>(
        method: M,
        ...arguments_: ServerOperationArguments<M>
    ): Promise<ServerOperationResult<M>> {
        const callbackError = desktopCommandCallbackError(method, this.options.logger);
        if (callbackError) return Promise.reject(callbackError);
        const attached = this.client;
        if (!attached) return Promise.reject(this.disconnectedRequestError());
        const client = attached as unknown as UntypedServerClient;
        const [parameters, timeoutMs] = arguments_;
        if (isDesktopServerOperation(method))
            return client.requestServerOperation(method, parameters, timeoutMs) as Promise<
                ServerOperationResult<M>
            >;
        if (!isCaxriMethod(method))
            return Promise.reject(new Error(`Unsupported Desktop Host method: ${method}`));
        return client.request(method, parameters) as Promise<ServerOperationResult<M>>;
    }

    forward(method: CaxriMethod, parameters: unknown, requestId: string): Promise<unknown> {
        const attached = this.client;
        if (!attached) return Promise.reject(this.disconnectedRequestError());
        const client = attached as unknown as UntypedServerClient;
        return client.requestWithId(requestId, method, parameters);
    }

    markDesktopReady(): Promise<void> {
        const client = this.client;
        if (!client) return Promise.reject(this.disconnectedRequestError());
        this.lifecycle = transitionServerConnection(this.lifecycle, { type: 'desktop-ready' });
        return client.markDesktopReady();
    }

    /**
     * Forces an immediate Desktop lease renewal. Intended to be called from Main's `powerMonitor` `resume` (and
     * `unlock-screen`) handlers so a woken Desktop reasserts its lease before Server Core's own post-sleep expiry timer
     * can win the race; see `ServerClient.renewLeaseNow`. A no-op while disconnected; the reconnect path establishes a
     * fresh lease on its own.
     */
    renewLeaseNow(): void {
        this.client?.renewLeaseNow();
    }

    /**
     * Fences Server recovery for the rest of this Main lifetime once a quit is accepted. Without it, a Server Core that
     * exits during quit teardown (for example killed by the same SIGTERM that is quitting Desktop) is reported as a
     * crash: the supervisor spawns a replacement Server and the replacement resumes Agent work nobody asked for.
     */
    markQuitting(): void {
        this.isQuitting = true;
    }

    close(): void {
        this.disposeLifecycle();
        /**
         * Main disposal is terminal for Renderer work, unlike a recoverable transport loss.
         */
        this.client?.close({ cancelPendingRequests: true });
        this.client = undefined;
    }

    /**
     * Ends every live Terminal before stopping Server Core so an explicit Desktop quit releases external Agent session
     * locks and cannot be auto-restored as interrupted work by a later Caxri launch. Disposal is fenced before either
     * request because the expected transport close from `host.stop` must never start the recovery loop.
     */
    async stopServer(): Promise<void> {
        const attached = this.client;
        if (!attached) throw this.disconnectedRequestError();
        const pid = this.serverPid;
        const client = attached as unknown as UntypedServerClient;
        this.disposeLifecycle();
        this.client = undefined;
        let didTerminationFail = false;
        let terminationFailure: unknown;
        let didHostStopFail = false;
        let hostStopFailure: unknown;
        try {
            try {
                await client.requestServerOperation('terminal.terminateAll', undefined, undefined);
            } catch (error) {
                didTerminationFail = true;
                terminationFailure = error;
            }
            try {
                await client.request('host.stop', { confirmLivePtys: true });
                if (pid !== undefined) {
                    this.serverSupervisor.releaseProcess(pid);
                    await waitForServerExit(this.serverSupervisor, pid);
                }
            } catch (error) {
                didHostStopFail = true;
                hostStopFailure = error;
            }
        } finally {
            attached.close({ cancelPendingRequests: true });
            this.serverPid = undefined;
        }
        if (didTerminationFail && didHostStopFail)
            throw new AggregateError(
                [terminationFailure, hostStopFailure],
                'Could not terminate tasks or stop Caxri Server',
            );
        if (didHostStopFail) throw hostStopFailure;
        if (didTerminationFail) throw terminationFailure;
    }

    /**
     * Compatibility name for old Main teardown call sites; it only closes this Desktop attachment.
     */
    shutdown(): Promise<void> {
        this.close();
        return Promise.resolve();
    }
}

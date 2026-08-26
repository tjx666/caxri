import { dirname, resolve } from 'node:path';
import process from 'node:process';

import type { RecoveringEventClient, ServerConnectionState } from '@caxri/client';
import {
    createRecoveringEventClient,
    initialServerConnectionState,
    transitionServerConnection,
} from '@caxri/client';
import type { ServerClient } from '@caxri/client/supervise';
import {
    connectDesktopToServer,
    ensureServer,
    resolveServerArtifact,
} from '@caxri/client/supervise';
import type {
    CaxriMethod,
    DesktopLeaseRevocationReason,
    DesktopOperation,
    DesktopTargetPayload,
    ServerDesktopLaunch,
    ServerEvent,
    ServerOperation,
    ServerOperationArguments,
    ServerOperationResult,
} from '@caxri/protocol';
import {
    CaxriError,
    errorMessage,
    isCaxriMethod,
    isDesktopServerOperation,
    SERVER_DESKTOP_LAUNCH_ENVIRONMENT_KEY,
} from '@caxri/protocol';
import type { E2EAgentPolicy, StructuredLogger } from '@caxri/system';
import { computeBuildFingerprint, e2eAgentPolicyEnvironment, logEventCatalog } from '@caxri/system';

import type { ServerBuildIdentity } from './server-staleness';
import { isServerBuildStale } from './server-staleness';

type DesktopCommandHandler = (
    operation: DesktopOperation,
    consumeTarget: () => Promise<DesktopTargetPayload>,
) => Promise<unknown>;

interface UntypedServerClient {
    request(method: CaxriMethod, parameters?: unknown): Promise<unknown>;
    requestServerOperation(
        method: ServerOperation,
        parameters?: unknown,
        timeoutMs?: number,
    ): Promise<unknown>;
    requestWithId(id: string, method: CaxriMethod, parameters?: unknown): Promise<unknown>;
}

export interface DesktopServerConnectionOptions {
    agentHooksPath?: string;
    /**
     * This Desktop build's commit/version identity, compared against `host.status` to replace a detached Server still
     * running an older build. The `buildId` half is never passed in: it is a content fingerprint of the on-disk Server
     * artifact bundles computed per connection attempt (see `computeBuildFingerprint`), because a build-time identifier
     * baked into the window bundle diverges from the Server artifact during development.
     */
    buildIdentity: ServerBuildIdentity;
    /**
     * Test seam for the on-disk bundle fingerprint; production uses `computeBuildFingerprint`.
     */
    computeBuildId?: (outputDirectory: string) => Promise<string | undefined>;
    cliPath: string;
    currentDirectory: string;
    desktopId: string;
    desktopLaunch: ServerDesktopLaunch;
    e2eAgentPolicy?: E2EAgentPolicy;
    handleCommand: DesktopCommandHandler;
    logger: StructuredLogger;
    serverArtifactRoot: string;
    userDataPath: string;
}

const SERVER_REPLACEMENT_EXIT_TIMEOUT_MS = 10_000;

/**
 * Waits for a stopped Server process to disappear so `ensureServer` re-discovery cannot race the old manifest. Signal 0
 * only probes liveness; an `ESRCH` throw means the process is gone. On timeout the caller simply proceeds — the final
 * attempt downgrades a still-stale Server to a warning.
 */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
        // eslint-disable-next-line no-await-in-loop -- sequential liveness polling by design
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

export function resolveDesktopLaunch(options: {
    currentDirectory: string;
    executable: string;
    isPackaged: boolean;
}): ServerDesktopLaunch {
    if (options.isPackaged)
        return { executable: options.executable, args: [], cwd: dirname(options.executable) };
    const projectRoot = resolve(options.currentDirectory, '../..');
    return { executable: options.executable, args: [projectRoot], cwd: projectRoot };
}

/**
 * Desktop-side client facade for typed Server operations and recovery.
 */
export class DesktopServerConnection extends EventTarget {
    private client?: ServerClient;
    private events?: RecoveringEventClient;
    private eventsServerIdentity?: string;
    private serverPid?: number;
    private starting?: Promise<void>;
    private reconnectTask?: Promise<void>;
    private lifecycle: ServerConnectionState = initialServerConnectionState;
    /**
     * Once this connection has replaced one stale Server, further mismatches only warn. Without this instance-level
     * guard, every background reconnect (`reconnectUntilAttached` → `connect`) restarts the replacement from scratch,
     * and a persistent mismatch — e.g. two Desktops of different builds sharing one Server — becomes a kill/spawn
     * storm.
     */
    private hasReplacedStaleServer = false;

    constructor(private readonly options: DesktopServerConnectionOptions) {
        super();
    }

    private async connect(): Promise<'same' | 'replaced'> {
        let serverIdentity = await this.attachToCurrentServer();
        serverIdentity ??= await this.attachToCurrentServer(true);
        if (serverIdentity === undefined)
            throw new CaxriError('UNAVAILABLE', 'Replacement Caxri Host still reports stale code');
        const client = await connectDesktopToServer(
            this.options.userDataPath,
            this.options.desktopId,
            this.options.handleCommand,
        );
        this.client = client;
        client.onClose((reason) => this.handleConnectionLoss(client, reason));
        const isServerContinuity =
            this.eventsServerIdentity !== undefined && this.eventsServerIdentity !== serverIdentity;
        // Reconnecting to the SAME Server process must keep the consumed event cursor: restarting at
        // zero would replay the whole journal and stale events (for example old `settings.changed`
        // payloads) would clobber newer Renderer state. A replaced Server starts a fresh journal, so
        // only then does the recovery cursor reset.
        if (!this.events || this.eventsServerIdentity !== serverIdentity) {
            this.events = createRecoveringEventClient({
                emit: (event) => {
                    this.dispatchEvent(new CustomEvent<ServerEvent>('event', { detail: event }));
                },
                onError: (error) =>
                    this.options.logger.write('error', logEventCatalog.host.eventRecoveryFailed, {
                        fields: {
                            error:
                                error instanceof Error ? error.message : 'Unknown recovery error',
                        },
                    }),
                // Resolved per call so recovery always targets the currently attached client
                // instead of a connection that has since been lost.
                recover: (afterCursor) => {
                    const attached = this.client;
                    if (!attached) return Promise.reject(this.disconnectedRequestError());
                    return attached.request('events.recover', { afterCursor });
                },
            });
            this.eventsServerIdentity = serverIdentity;
        }
        const events = this.events;
        client.onEvent((event) => events.receive(event));
        await events.start();
        return isServerContinuity ? 'replaced' : 'same';
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
     * mismatch — including two ping-ponging Desktops of different builds — degrades to a logged warning instead of an
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
        const operator = await ensureServer(this.options.userDataPath, {
            artifactRoot: artifact.rootPath,
            environment: {
                [SERVER_DESKTOP_LAUNCH_ENVIRONMENT_KEY]: JSON.stringify(this.options.desktopLaunch),
                ...e2eAgentPolicyEnvironment(this.options.e2eAgentPolicy),
                ...(process.env.CAXRI_E2E_WINDOW_MODE && {
                    CAXRI_E2E_WINDOW_MODE: process.env.CAXRI_E2E_WINDOW_MODE,
                }),
                ...(process.env.CAXRI_E2E_WORKER_NAMESPACE && {
                    CAXRI_E2E_WORKER_NAMESPACE: process.env.CAXRI_E2E_WORKER_NAMESPACE,
                }),
                ...(process.env.CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS && {
                    CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS:
                        process.env.CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS,
                }),
                ...(process.env.CAXRI_TEST_ROOT_PATH && {
                    CAXRI_TEST_ROOT_PATH: process.env.CAXRI_TEST_ROOT_PATH,
                }),
                ...(process.env.CAXRI_TEST_ROOT_PATHS && {
                    CAXRI_TEST_ROOT_PATHS: process.env.CAXRI_TEST_ROOT_PATHS,
                }),
                ...(this.options.agentHooksPath && {
                    CAXRI_AGENT_HOOKS_PATH: this.options.agentHooksPath,
                }),
                CAXRI_CLI_PATH: this.options.cliPath,
            },
        });
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
                    this.options.logger.write('warn', logEventCatalog.host.versionMismatch, {
                        fields: skewFields,
                    });
                } else {
                    /**
                     * Live PTYs die with the stale Server, which is the intended trade: silently serving Terminals from
                     * an older build is the failure mode this replaces.
                     */
                    this.options.logger.write('warn', logEventCatalog.host.staleBuildReplaced, {
                        fields: skewFields,
                    });
                    this.hasReplacedStaleServer = true;
                    await operator.request('host.stop', { confirmLivePtys: true });
                    await waitForProcessExit(status.pid, SERVER_REPLACEMENT_EXIT_TIMEOUT_MS);
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
    private handleConnectionLoss(lost: ServerClient, reason?: DesktopLeaseRevocationReason): void {
        if (this.lifecycle.status === 'disposed' || this.client !== lost) return;
        this.client = undefined;
        this.starting = undefined;
        this.lifecycle = transitionServerConnection(this.lifecycle, {
            type: 'connection-lost',
            atMs: Date.now(),
            reason: reason === 'replaced' ? 'replaced' : 'transport',
        });
        if (reason === 'replaced') {
            this.options.logger.write('warn', logEventCatalog.host.desktopLeaseReplaced, {});
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
        this.options.logger.write('warn', logEventCatalog.host.connectionLost, {});
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
            const backoffMs = Math.min(500 * 2 ** (attempt - 1), 10_000);
            // eslint-disable-next-line no-await-in-loop -- sequential backoff between retries.
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            if (this.lifecycle !== waiting) continue;
            this.lifecycle = transitionServerConnection(this.lifecycle, {
                type: 'backoff-elapsed',
            });
            try {
                // eslint-disable-next-line no-await-in-loop -- each attempt must settle before the next backoff.
                await this.start();
            } catch (error) {
                this.options.logger.write('warn', logEventCatalog.host.reconnectFailed, {
                    fields: { attempt, error: errorMessage(error, 'unknown') },
                });
                continue;
            }
            if (this.lifecycle.status !== 'recovering') {
                if (this.lifecycle.status === 'backoff') continue;
                return;
            }
            const recovering = this.lifecycle;
            const downtimeMs = Date.now() - outageStartedAtMs;
            const isServerReplaced = recovering.serverContinuity === 'replaced';
            this.options.logger.write('info', logEventCatalog.host.reconnected, {
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
                    this.options.logger.write('error', logEventCatalog.host.desktopReadyFailed, {
                        fields: { error: errorMessage(error, 'unknown') },
                    });
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

    serverProcessId(): number | undefined {
        return this.serverPid;
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

    close(): void {
        this.lifecycle = transitionServerConnection(this.lifecycle, { type: 'dispose' });
        /**
         * Main disposal is terminal for Renderer work, unlike a recoverable transport loss.
         */
        this.client?.close({ cancelPendingRequests: true });
        this.client = undefined;
    }

    /**
     * Compatibility name for old Main teardown call sites; it only closes this Desktop attachment.
     */
    shutdown(): Promise<void> {
        this.close();
        return Promise.resolve();
    }
}

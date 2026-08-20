import { dirname, join, resolve } from 'node:path';
import process from 'node:process';

import type { HostClient } from '@caxri/cli';
import { connectDesktopToHost, ensureHost } from '@caxri/cli';

import type { HostDesktopLaunch } from '../shared/ipc/desktop-launch';
import { HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY } from '../shared/ipc/desktop-launch';
import { isDesktopRuntimeMethod } from '../shared/ipc/desktop-runtime';
import { CaxriError, errorMessage } from '../shared/ipc/errors';
import type { RecoveringEventClient } from '../shared/ipc/event-client';
import { createRecoveringEventClient } from '../shared/ipc/event-client';
import type { RuntimeEvent } from '../shared/ipc/events';
import type {
    DesktopLeaseRevocationReason,
    DesktopOperation,
    DesktopTargetPayload,
} from '../shared/ipc/local-transport';
import type {
    CaxriMethod,
    RuntimeMethod,
    RuntimeMethodResult,
    RuntimeParamsArg as RuntimeParametersArgument,
} from '../shared/ipc/methods';
import { isCaxriMethod } from '../shared/ipc/methods';
import { computeBuildFingerprint } from '../shared/node/build-fingerprint';
import type { E2EAgentPolicy } from '../shared/node/e2e-agent-policy';
import { e2eAgentPolicyEnvironment } from '../shared/node/e2e-agent-policy';
import type { StructuredLogger } from '../shared/node/logger';
import type { HostBuildIdentity } from './host-staleness';
import { isHostBuildStale } from './host-staleness';

type DesktopCommandHandler = (
    operation: DesktopOperation,
    consumeTarget: () => Promise<DesktopTargetPayload>,
) => Promise<unknown>;

interface UntypedHostClient {
    request(method: CaxriMethod, parameters?: unknown): Promise<unknown>;
    requestRuntime(
        method: RuntimeMethod,
        parameters?: unknown,
        timeoutMs?: number,
    ): Promise<unknown>;
    requestWithId(id: string, method: CaxriMethod, parameters?: unknown): Promise<unknown>;
}

export interface DesktopHostConnectionOptions {
    agentHooksPath?: string;
    /**
     * This Desktop build's commit/version identity, compared against `host.status` to replace a detached Host still
     * running an older build. The `buildId` half is never passed in: it is a content fingerprint of the on-disk
     * `host.js`/`runtime.js` bundles computed per connection attempt (see `computeBuildFingerprint`), because a
     * build-time identifier baked into the window bundle diverges from the Host bundle under electron-vite dev.
     */
    buildIdentity: HostBuildIdentity;
    /**
     * Test seam for the on-disk bundle fingerprint; production uses `computeBuildFingerprint`.
     */
    computeBuildId?: (outputDirectory: string) => Promise<string | undefined>;
    cliPath: string;
    currentDirectory: string;
    desktopId: string;
    desktopLaunch: HostDesktopLaunch;
    e2eAgentPolicy?: E2EAgentPolicy;
    handleCommand: DesktopCommandHandler;
    logger: StructuredLogger;
    userDataPath: string;
}

const HOST_REPLACEMENT_EXIT_TIMEOUT_MS = 10_000;

/**
 * Waits for a stopped Host process to disappear so `ensureHost` re-discovery cannot race the old manifest. Signal 0
 * only probes liveness; an `ESRCH` throw means the process is gone. On timeout the caller simply proceeds — the final
 * attempt downgrades a still-stale Host to a warning.
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
}): HostDesktopLaunch {
    if (options.isPackaged)
        return { executable: options.executable, args: [], cwd: dirname(options.executable) };
    const projectRoot = resolve(options.currentDirectory, '../..');
    return { executable: options.executable, args: [projectRoot], cwd: projectRoot };
}

/**
 * Desktop-side client facade preserving Main's typed Runtime request call sites during migration.
 */
export class DesktopHostConnection extends EventTarget {
    private client?: HostClient;
    private events?: RecoveringEventClient;
    private eventsHostIdentity?: string;
    private hostPid?: number;
    private runtimePid?: number;
    private starting?: Promise<void>;
    private disposed = false;
    private isDesktopReadyAnnounced = false;
    private isReconnecting = false;
    /**
     * Wall-clock start of the current outage. Kept across failed reconnect rounds so `downtimeMs` reports the full
     * user-visible gap (transient `terminal.output` events sent inside it were dropped), not just the last retry.
     */
    private connectionLostAtMs?: number;
    private isHostReplacedOnLastConnect = false;
    private isLeaseReplaced = false;
    /**
     * Once this connection has replaced one stale Host, further mismatches only warn. Without this instance-level
     * guard, every background reconnect (`reconnectUntilAttached` → `connect`) restarts the replacement from scratch,
     * and a persistent mismatch — e.g. two Desktops of different builds sharing one Host — becomes a kill/spawn storm.
     */
    private hasReplacedStaleHost = false;

    constructor(private readonly options: DesktopHostConnectionOptions) {
        super();
    }

    private async connect(): Promise<void> {
        let hostIdentity = await this.attachToCurrentHost();
        hostIdentity ??= await this.attachToCurrentHost(true);
        if (hostIdentity === undefined)
            throw new CaxriError('UNAVAILABLE', 'Replacement Caxri Host still reports stale code');
        const client = await connectDesktopToHost(
            this.options.userDataPath,
            this.options.desktopId,
            this.options.handleCommand,
        );
        this.client = client;
        client.onClose((reason) => this.handleConnectionLoss(client, reason));
        this.isHostReplacedOnLastConnect =
            this.eventsHostIdentity !== undefined && this.eventsHostIdentity !== hostIdentity;
        // Reconnecting to the SAME Host process must keep the consumed event cursor: restarting at
        // zero would replay the whole journal and stale events (for example old `settings.changed`
        // payloads) would clobber newer Renderer state. A replaced Host starts a fresh journal, so
        // only then does the recovery cursor reset.
        if (!this.events || this.eventsHostIdentity !== hostIdentity) {
            this.events = createRecoveringEventClient({
                emit: (event) => {
                    this.dispatchEvent(new CustomEvent<RuntimeEvent>('event', { detail: event }));
                },
                onError: (error) =>
                    this.options.logger.write('error', 'host.event_recovery_failed', {
                        fields: {
                            error:
                                error instanceof Error ? error.message : 'Unknown recovery error',
                        },
                    }),
                // Resolved per call so recovery always targets the currently attached client
                // instead of a connection that has since been lost.
                recover: (afterCursor) => {
                    const attached = this.client;
                    if (!attached)
                        return Promise.reject(
                            new CaxriError(
                                'UNAVAILABLE',
                                'Desktop is not connected to the Caxri Host',
                            ),
                        );
                    return attached.request('events.recover', { afterCursor });
                },
            });
            this.eventsHostIdentity = hostIdentity;
        }
        const events = this.events;
        client.onEvent((event) => events.receive(event));
        await events.start();
    }

    /**
     * Ensures a Host is running and vets its build before serving it. A stale Host (older build than this Desktop) is
     * stopped and `undefined` is returned so the caller can ensure a fresh one. Replacement happens at most once per
     * connection instance (`hasReplacedStaleHost`) and never on the final attempt of a connect, so a persistent
     * mismatch — including two ping-ponging Desktops of different builds — degrades to a logged warning instead of an
     * endless kill/spawn loop.
     */
    private async attachToCurrentHost(isFinalAttempt = false): Promise<string | undefined> {
        // Recomputed per attempt: a watch rebuild may have replaced the bundles since the last connect, and the
        // freshly spawned replacement Host reads the same bytes, so both sides agree by construction.
        const desktopBuildId = await (this.options.computeBuildId ?? computeBuildFingerprint)(
            this.options.currentDirectory,
        );
        const buildIdentity: HostBuildIdentity = {
            ...this.options.buildIdentity,
            buildId: desktopBuildId,
        };
        const operator = await ensureHost(this.options.userDataPath, {
            executable: process.execPath,
            entryPath: join(this.options.currentDirectory, 'host.js'),
            environment: {
                [HOST_DESKTOP_LAUNCH_ENVIRONMENT_KEY]: JSON.stringify(this.options.desktopLaunch),
                ...e2eAgentPolicyEnvironment(this.options.e2eAgentPolicy),
                ...(process.env.CAXRI_E2E_WINDOW_MODE && {
                    CAXRI_E2E_WINDOW_MODE: process.env.CAXRI_E2E_WINDOW_MODE,
                }),
                ...(process.env.CAXRI_E2E_WORKER_NAMESPACE && {
                    CAXRI_E2E_WORKER_NAMESPACE: process.env.CAXRI_E2E_WORKER_NAMESPACE,
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
                hostPid: status.pid,
                hostVersion: status.version,
            };
            if (isHostBuildStale(buildIdentity, status)) {
                if (isFinalAttempt || this.hasReplacedStaleHost) {
                    this.options.logger.write('warn', 'host.version_mismatch', {
                        fields: skewFields,
                    });
                } else {
                    /**
                     * Live PTYs die with the stale Host, which is the intended trade: silently serving Terminals from
                     * an older build is the failure mode this replaces.
                     */
                    this.options.logger.write('warn', 'host.stale_build_replaced', {
                        fields: skewFields,
                    });
                    this.hasReplacedStaleHost = true;
                    await operator.request('host.stop', { confirmLivePtys: true });
                    await waitForProcessExit(status.pid, HOST_REPLACEMENT_EXIT_TIMEOUT_MS);
                    return undefined;
                }
            }
            this.hostPid = status.pid;
            this.runtimePid = status.runtimePid;
            return `${status.pid}:${status.startedAt}`;
        } finally {
            operator.close();
        }
    }

    /**
     * Drops a lost attachment and keeps retrying recoverable outages in the background. An orderly same-profile Desktop
     * takeover is terminal for this Main instance so it cannot evict the replacement in return.
     */
    private handleConnectionLoss(lost: HostClient, reason?: DesktopLeaseRevocationReason): void {
        if (this.disposed || this.client !== lost) return;
        this.client = undefined;
        this.starting = undefined;
        if (reason === 'replaced') {
            this.isLeaseReplaced = true;
            this.connectionLostAtMs = undefined;
            this.options.logger.write('warn', 'host.desktop_lease_replaced', {});
            this.dispatchEvent(
                new CustomEvent<RuntimeEvent>('event', {
                    detail: {
                        event: 'host.connectionChanged',
                        payload: { status: 'replaced' },
                    },
                }),
            );
            return;
        }
        this.connectionLostAtMs ??= Date.now();
        this.options.logger.write('warn', 'host.connection_lost', {});
        // The retry loop handles every failure internally (it never rejects), so the kickoff is
        // intentionally fire-and-forget from this synchronous close listener.
        // eslint-disable-next-line no-void
        void this.reconnectUntilAttached();
    }

    private isReconnectStopped(): boolean {
        return this.disposed || this.isLeaseReplaced;
    }

    private async reconnectUntilAttached(): Promise<void> {
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        try {
            for (let attempt = 1; ; attempt += 1) {
                const backoffMs = Math.min(500 * 2 ** (attempt - 1), 10_000);
                // eslint-disable-next-line no-await-in-loop -- sequential backoff between retries.
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
                if (this.isReconnectStopped()) return;
                try {
                    // eslint-disable-next-line no-await-in-loop -- see the backoff note above.
                    await this.start();
                } catch (error) {
                    this.options.logger.write('warn', 'host.reconnect_failed', {
                        fields: { attempt, error: errorMessage(error, 'unknown') },
                    });
                    continue;
                }
                const downtimeMs =
                    this.connectionLostAtMs === undefined
                        ? 0
                        : Date.now() - this.connectionLostAtMs;
                const isHostReplaced = this.isHostReplacedOnLastConnect;
                this.options.logger.write('info', 'host.reconnected', {
                    fields: { attempt, downtimeMs, isHostReplaced },
                });
                // Re-announce Renderer readiness so the replacement Host resumes delivering
                // one-shot window commands without waiting for another boot.
                if (this.isDesktopReadyAnnounced)
                    try {
                        // eslint-disable-next-line no-await-in-loop -- final await before returning.
                        await this.markDesktopReady();
                        /**
                         * `desktop.ready` and this recovery command share Host's ordered control queue. The recovery
                         * reply is therefore a readiness barrier: it includes every durable event journaled after the
                         * first reconnect recovery and before ready became active, without adding an initial-startup
                         * round trip.
                         */
                        // eslint-disable-next-line no-await-in-loop -- ordered readiness barrier for this attempt.
                        await this.events?.start();
                    } catch (error) {
                        this.options.logger.write('error', 'host.desktop_ready_failed', {
                            fields: { error: errorMessage(error, 'unknown') },
                        });
                    }
                // The replacement connection can be lost again while this loop is still finishing
                // (its close listener sees `isReconnecting` and cannot start another loop), so a
                // cleared attachment here means "keep retrying", not success.
                if (!this.client) {
                    if (this.isReconnectStopped()) return;
                    continue;
                }
                this.connectionLostAtMs = undefined;
                /**
                 * Transient events (PTY bytes above all) sent during the outage were dropped without replay, so the
                 * Renderer must re-attach mounted Terminal panes; durable-event recovery alone cannot restore them.
                 */
                this.dispatchEvent(
                    new CustomEvent<RuntimeEvent>('event', {
                        detail: {
                            event: 'host.connectionChanged',
                            payload: {
                                status: 'reconnected',
                                downtimeMs,
                                attempt,
                                isHostReplaced,
                            },
                        },
                    }),
                );
                return;
            }
        } finally {
            this.isReconnecting = false;
        }
    }

    processId(): number | undefined {
        return this.runtimePid;
    }

    hostProcessId(): number | undefined {
        return this.hostPid;
    }

    start(): Promise<void> {
        if (this.isLeaseReplaced)
            return Promise.reject(
                new CaxriError(
                    'CONFLICT',
                    'Another Caxri window replaced this Desktop profile lease',
                ),
            );
        const starting = this.starting ?? this.connect();
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
     * Subscribes to Runtime protocol events; returns an unsubscribe function.
     */
    onEvent(listener: (event: RuntimeEvent) => void): () => void {
        const handler = (event: Event): void =>
            listener((event as CustomEvent<RuntimeEvent>).detail);
        this.addEventListener('event', handler);
        return () => this.removeEventListener('event', handler);
    }

    request<M extends RuntimeMethod>(
        method: M,
        ...arguments_: RuntimeParametersArgument<M>
    ): Promise<RuntimeMethodResult<M>> {
        const attached = this.client;
        if (!attached)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Desktop is not connected to the Caxri Host'),
            );
        const client = attached as unknown as UntypedHostClient;
        const [parameters, timeoutMs] = arguments_;
        if (isDesktopRuntimeMethod(method))
            return client.requestRuntime(method, parameters, timeoutMs) as Promise<
                RuntimeMethodResult<M>
            >;
        if (!isCaxriMethod(method))
            return Promise.reject(new Error(`Unsupported Desktop Host method: ${method}`));
        return client.request(method, parameters) as Promise<RuntimeMethodResult<M>>;
    }

    forward(method: CaxriMethod, parameters: unknown, requestId: string): Promise<unknown> {
        const attached = this.client;
        if (!attached)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Desktop is not connected to the Caxri Host'),
            );
        const client = attached as unknown as UntypedHostClient;
        return client.requestWithId(requestId, method, parameters);
    }

    markDesktopReady(): Promise<void> {
        const client = this.client;
        if (!client)
            return Promise.reject(
                new CaxriError('UNAVAILABLE', 'Desktop is not connected to the Caxri Host'),
            );
        this.isDesktopReadyAnnounced = true;
        return client.markDesktopReady();
    }

    close(): void {
        this.disposed = true;
        this.client?.close();
        this.client = undefined;
    }

    /**
     * Compatibility name for old Main teardown call sites; it never stops the Host-owned Runtime.
     */
    shutdown(): Promise<void> {
        this.close();
        return Promise.resolve();
    }
}

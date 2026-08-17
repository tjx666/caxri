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
import type { DesktopOperation, DesktopTargetPayload } from '../shared/ipc/local-transport';
import type {
    CaxriMethod,
    RuntimeMethod,
    RuntimeMethodResult,
    RuntimeParamsArg as RuntimeParametersArgument,
} from '../shared/ipc/methods';
import { isCaxriMethod } from '../shared/ipc/methods';
import type { E2EAgentPolicy } from '../shared/node/e2e-agent-policy';
import { e2eAgentPolicyEnvironment } from '../shared/node/e2e-agent-policy';
import type { StructuredLogger } from '../shared/node/logger';

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
    cliPath: string;
    currentDirectory: string;
    desktopId: string;
    desktopLaunch: HostDesktopLaunch;
    e2eAgentPolicy?: E2EAgentPolicy;
    handleCommand: DesktopCommandHandler;
    logger: StructuredLogger;
    userDataPath: string;
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

    constructor(private readonly options: DesktopHostConnectionOptions) {
        super();
    }

    private async connect(): Promise<void> {
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
        let hostIdentity: string;
        try {
            const status = await operator.request('host.status');
            this.hostPid = status.pid;
            this.runtimePid = status.runtimePid;
            hostIdentity = `${status.pid}:${status.startedAt}`;
            this.warnOnVersionSkew(status);
        } finally {
            operator.close();
        }
        const client = await connectDesktopToHost(
            this.options.userDataPath,
            this.options.desktopId,
            this.options.handleCommand,
        );
        this.client = client;
        client.onClose(() => this.handleConnectionLoss(client));
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
     * A detached Host survives Desktop restarts, so after a rebuild the adopted Host can still be running an older
     * build; surface the skew instead of serving it silently. The commit compare catches dev rebuilds where the package
     * version never changes.
     */
    private warnOnVersionSkew(status: { commit?: string; pid: number; version: string }): void {
        const desktopVersion = process.env.CAXRI_APP_VERSION;
        const desktopCommit = process.env.CAXRI_GIT_COMMIT;
        const isVersionSkewed = Boolean(
            desktopVersion && desktopVersion !== 'unknown' && status.version !== desktopVersion,
        );
        const isCommitSkewed = Boolean(
            desktopCommit &&
            desktopCommit !== 'unknown' &&
            status.commit &&
            status.commit !== 'unknown' &&
            status.commit !== desktopCommit,
        );
        if (!isVersionSkewed && !isCommitSkewed) return;
        this.options.logger.write('warn', 'host.version_mismatch', {
            fields: {
                desktopCommit: desktopCommit ?? 'unknown',
                desktopVersion: desktopVersion ?? 'unknown',
                hostCommit: status.commit ?? 'unknown',
                hostPid: status.pid,
                hostVersion: status.version,
            },
        });
    }

    /**
     * Drops a lost attachment and keeps retrying in the background: the detached Host may be crashing, restarting, or
     * replaced, and requests fail fast with `UNAVAILABLE` until a fresh connection (and Host relaunch via `ensureHost`)
     * succeeds.
     */
    private handleConnectionLoss(lost: HostClient): void {
        if (this.disposed || this.client !== lost) return;
        this.client = undefined;
        this.starting = undefined;
        this.connectionLostAtMs ??= Date.now();
        this.options.logger.write('warn', 'host.connection_lost', {});
        // The retry loop handles every failure internally (it never rejects), so the kickoff is
        // intentionally fire-and-forget from this synchronous close listener.
        // eslint-disable-next-line no-void
        void this.reconnectUntilAttached();
    }

    private async reconnectUntilAttached(): Promise<void> {
        if (this.isReconnecting) return;
        this.isReconnecting = true;
        try {
            for (let attempt = 1; ; attempt += 1) {
                const backoffMs = Math.min(500 * 2 ** (attempt - 1), 10_000);
                // eslint-disable-next-line no-await-in-loop -- sequential backoff between retries.
                await new Promise((resolve) => setTimeout(resolve, backoffMs));
                if (this.disposed) return;
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
                    } catch (error) {
                        this.options.logger.write('error', 'host.desktop_ready_failed', {
                            fields: { error: errorMessage(error, 'unknown') },
                        });
                    }
                // The replacement connection can be lost again while this loop is still finishing
                // (its close listener sees `isReconnecting` and cannot start another loop), so a
                // cleared attachment here means "keep retrying", not success.
                if (!this.client) continue;
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

import type {
    ServerEvent,
    SshEnvironmentState,
    SshHostAskpassRequest,
    SshHostFailureReason,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { DesktopServerConnection } from '../../connection/server-connection';
import type { SshHostRendererRoute } from '../../workbench-ipc';
import { knownHostsNameOf } from '../destination';
import type {
    SshHostEnvironment,
    SshHostEnvironmentParts,
    SshHostEnvironmentsOptions,
    SshHostStatePatch,
    SshHostSupervisor,
} from './host-environments';

interface PendingPrompt {
    request: SshHostAskpassRequest;
    resolve(response: string | null): void;
}

/**
 * Failure reasons only the user's answer can resolve; automatic reconnection stops at them. `cancelled` stops it too,
 * but the user chose that outcome, so nothing is left waiting for them.
 */
const USER_ACTION_REASONS = new Set<SshHostFailureReason>(['authentication', 'hostKey']);

/**
 * Phases in which a connection attempt is running and `sshHost.cancel` can stop it.
 */
const CANCELLABLE_PHASES = new Set<SshEnvironmentState['phase']>([
    'connecting',
    'probing',
    'installing',
    'starting',
    'reconnecting',
]);

export class SshHostEnvironmentController implements SshHostEnvironment {
    private current: SshEnvironmentState;
    private phaseStartedAt = performance.now();
    private readonly prompts: PendingPrompt[] = [];
    private readonly supervisor: SshHostSupervisor;
    private readonly attached = Promise.withResolvers<void>();
    private hasAttached = false;
    private isDisposed = false;
    private readonly parts: SshHostEnvironmentParts;
    readonly connection: DesktopServerConnection;
    route: SshHostRendererRoute;
    readonly sendEvent: (event: ServerEvent) => void;

    /**
     * @param destination The destination as the user typed it.
     * @param id The identity `keyOf` resolved (`user@hostname:port`), which also names the SSH Host the way
     *   `known_hosts` does. It is the environment's `id` and is carried in the state as `hostIdentity`, so the Renderer
     *   keys its device-local state by the SSH Host rather than by whichever alias connected it.
     * @param options How this environment's connection and supervisor are created.
     * @param onChanged Reports a state change to the registry.
     */
    constructor(
        readonly destination: string,
        readonly id: string,
        private readonly options: SshHostEnvironmentsOptions,
        private readonly onChanged: () => void,
    ) {
        this.current = {
            kind: 'ssh',
            destination,
            hostIdentity: id,
            phase: 'connecting',
            needsUserAction: false,
        };
        const parts = options.create(destination, id, {
            askpass: (request, signal) => this.prompt(request, signal),
            update: (patch) => this.update(patch),
        });
        this.parts = parts;
        this.connection = parts.connection;
        this.supervisor = parts.supervisor;
        this.sendEvent = parts.sendEvent;
        this.route = parts.route;
        /**
         * Renderer requests issued while the first attachment is still connecting wait on it, like the local Server's.
         * The promise rejects when the environment is disconnected; marking it handled keeps one disconnected before
         * any request from reporting an unhandled rejection.
         */
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        this.attached.promise.catch(() => {});
        this.connection.onEvent((event) => {
            if (event.event !== 'host.connectionChanged') return;
            if (event.payload.status === 'reconnected')
                this.update({ phase: 'connected', failure: undefined, needsUserAction: false });
            /**
             * `replaced`: the connection stops for good once another Desktop holds the lease; without this the Host
             * would keep claiming to be connected while every request is cancelled. Nothing retries it, and there is no
             * OpenSSH question to answer, so `needsUserAction` stays false.
             */
            else
                this.update({
                    phase: 'disconnected',
                    failure: { reason: 'takenOver', message: '' },
                    needsUserAction: false,
                });
        });
    }

    private markAttached(): void {
        this.hasAttached = true;
        this.attached.resolve();
        this.update({
            phase: 'connected',
            failure: undefined,
            needsUserAction: false,
            progress: undefined,
        });
    }

    private fail(error: unknown): void {
        if (this.isDisposed || this.current.phase === 'stopped') return;
        const reason: SshHostFailureReason =
            this.current.failure?.reason ??
            (error instanceof CaxriError && error.code === 'CANCELLED' ? 'cancelled' : 'unknown');
        const message =
            this.current.failure?.message ??
            (error instanceof Error ? error.message : String(error));
        this.update({
            phase: 'failed',
            failure: { reason, message: message.slice(0, 2000) },
            needsUserAction: USER_ACTION_REASONS.has(reason),
        });
    }

    private prompt(request: SshHostAskpassRequest, signal: AbortSignal): Promise<string | null> {
        if (this.isDisposed || signal.aborted) return Promise.resolve(null);
        const startedAt = performance.now();
        return new Promise<string | null>((resolve) => {
            const onAbort = (): void => this.reply(request.requestId, null);
            const settle = (response: string | null): void => {
                signal.removeEventListener('abort', onAbort);
                this.options.logger()?.write('info', logEventCatalog.sshHost.askpassPrompted, {
                    durationMs: performance.now() - startedAt,
                    fields: {
                        kind: request.kind,
                        outcome: response === null ? 'cancelled' : 'answered',
                        retry: request.retry ?? 0,
                    },
                });
                resolve(response);
            };
            signal.addEventListener('abort', onAbort, { once: true });
            this.prompts.push({ request, resolve: settle });
            this.update({ askpass: this.prompts[0]?.request });
            this.parts.focusWorkbench();
        });
    }

    private update(patch: SshHostStatePatch): void {
        if (this.isDisposed) return;
        const previous = this.current;
        const next: SshEnvironmentState = { ...previous, ...patch };
        for (const key of Object.keys(patch) as Array<keyof SshHostStatePatch>)
            if (patch[key] === undefined) delete next[key];
        if (next.failure?.reason === 'hostKey' && next.failure.knownHostsName === undefined) {
            const knownHostsName = knownHostsNameOf(this.id);
            if (knownHostsName) next.failure = { ...next.failure, knownHostsName };
        }
        this.current = next;
        if (next.phase !== previous.phase) {
            const now = performance.now();
            this.options
                .logger()
                ?.write(
                    next.phase === 'failed' ? 'warn' : 'info',
                    logEventCatalog.sshHost.phaseChanged,
                    {
                        durationMs: now - this.phaseStartedAt,
                        fields: {
                            phase: next.phase,
                            previousPhase: previous.phase,
                            reason: next.failure?.reason ?? null,
                            needsUserAction: next.needsUserAction,
                        },
                    },
                );
            this.phaseStartedAt = now;
        }
        this.sendEvent({ event: 'environment.changed', payload: next });
        this.onChanged();
    }

    state(): SshEnvironmentState {
        return this.current;
    }

    /**
     * Resolves once Server requests can be forwarded. Rejects only when the environment is closed.
     */
    whenAttached(): Promise<void> {
        return this.attached.promise;
    }

    async start(): Promise<void> {
        try {
            await this.connection.start();
            this.markAttached();
        } catch (error) {
            this.fail(error);
        }
    }

    async reconnect(): Promise<void> {
        if (this.isDisposed) return;
        this.supervisor.reconnect();
        this.update({
            phase: this.hasAttached ? 'reconnecting' : 'connecting',
            failure: undefined,
            needsUserAction: false,
        });
        try {
            await this.connection.resume();
            /**
             * The reconnect loop also settles when the supervisor stops on a terminal failure (a cancel, a rejected
             * password) without attaching; the supervisor has already reported that failure.
             */
            if (this.supervisor.isFailed()) this.fail(new CaxriError('CANCELLED', 'Not attached'));
            else this.markAttached();
        } catch (error) {
            this.fail(error);
        }
    }

    /**
     * Skips the rest of the automatic reconnect backoff, so the next attempt (and its attempt count) starts now.
     */
    retryNow(): boolean {
        return (
            !this.isDisposed && this.current.phase === 'reconnecting' && this.connection.retryNow()
        );
    }

    /**
     * Stops a connect, install, or reconnect the user no longer wants. The environment stays on a `cancelled` failure
     * so Reconnect can start over.
     */
    cancel(): void {
        if (this.isDisposed || !CANCELLABLE_PHASES.has(this.current.phase)) return;
        for (const prompt of this.prompts.slice()) this.reply(prompt.request.requestId, null);
        this.supervisor.cancel();
    }

    reply(requestId: string, response: string | null): void {
        const index = this.prompts.findIndex((prompt) => prompt.request.requestId === requestId);
        if (index === -1) return;
        const [prompt] = this.prompts.splice(index, 1);
        prompt.resolve(response);
        this.update({ askpass: this.prompts[0]?.request });
    }

    /**
     * Ends the remote Server with its Terminals and Agents. The caller then disconnects the environment, so a new
     * `sshHost.connect` starts a fresh Server.
     */
    async stopServer(): Promise<void> {
        this.update({ phase: 'stopped', needsUserAction: false });
        await this.connection.stopServer();
    }

    /**
     * Detaches without stopping the remote Server: its Terminals and Agents keep running on the SSH Host.
     */
    async dispose(): Promise<void> {
        if (this.isDisposed) return;
        this.isDisposed = true;
        const pending = this.prompts.slice();
        this.prompts.length = 0;
        for (const prompt of pending) prompt.resolve(null);
        this.attached.reject(new CaxriError('CANCELLED', 'The SSH Host was disconnected'));
        this.parts.unbind();
        this.connection.close();
        try {
            await this.supervisor.dispose();
        } catch {
            // Detaching is best effort; the remote Server keeps running regardless.
        }
    }
}

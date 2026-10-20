import type {
    EnvironmentState,
    ServerDesktopCredential,
    ServerEvent,
    ServerManifest,
    SshEnvironmentState,
    SshHostAskpassRequest,
    SshHostEntry,
    SshHostFailureReason,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow, WebContents } from 'electron';

import type { MainEnvironmentMethods } from '../main-environment-methods';
import type { DesktopServerSupervisor } from '../server-attachment';
import type { DesktopServerConnection } from '../server-connection';
import type { SshHostRendererRoute } from '../workbench-ipc';
import { knownHostsNameOf } from './destination';

/**
 * The SSH transport below one SSH Host window: it owns the ControlMaster, installs and launches the remote Server, and
 * forwards its endpoint. `DesktopServerConnection` drives it exactly like the local artifact supervisor.
 */
export interface SshHostSupervisor extends DesktopServerSupervisor {
    /**
     * The remote Server's manifest (endpoint rewritten to the local forward) and Desktop credential.
     */
    discoverDesktop(): Promise<{ credential: ServerDesktopCredential; manifest: ServerManifest }>;
    /**
     * Clears a failure that stopped automatic retries (`isFailed()`), so the next `ensure` tries again.
     */
    reconnect(): void;
    /**
     * Stops the attempt in flight at the user's request and reports a terminal `cancelled` failure until `reconnect()`.
     */
    cancel(): void;
    /**
     * Closes the ControlMaster and the forward. The remote Server keeps running.
     */
    dispose(): Promise<void>;
}

type SshHostStatePatch = Partial<
    Omit<SshEnvironmentState, 'destination' | 'hostIdentity' | 'kind'>
>;

/**
 * One SSH Host window and everything it is attached through.
 */
export interface SshHostEnvironment {
    readonly destination: string;
    readonly connection: DesktopServerConnection;
    readonly window: BrowserWindow;
    route: SshHostRendererRoute;
    state(): SshEnvironmentState;
    /**
     * Sends a Server event or Main-originated event to this window only.
     */
    sendEvent: (event: ServerEvent) => void;
}

export interface SshHostEnvironmentParts {
    connection: DesktopServerConnection;
    route: Omit<SshHostRendererRoute, 'window'>;
    sendEvent: (event: ServerEvent) => void;
    supervisor: SshHostSupervisor;
    window: BrowserWindow;
}

export interface SshHostEnvironmentHooks {
    /**
     * Shows one OpenSSH prompt in the window and resolves with the user's answer, or `null` when it was cancelled or
     * the helper gave up (`signal`).
     */
    askpass(request: SshHostAskpassRequest, signal: AbortSignal): Promise<string | null>;
    /**
     * The supervisor reports phase, progress, platform, and failures through this.
     */
    update(patch: SshHostStatePatch): void;
}

export interface SshHostEnvironmentsOptions {
    /**
     * Builds the window, supervisor, connection, and transport for one destination. Kept in the composition root
     * because it reuses Main's window chrome, Renderer loading, and Main method wiring.
     */
    create(destination: string, hooks: SshHostEnvironmentHooks): SshHostEnvironmentParts;
    listHosts(): Promise<SshHostEntry[]>;
    logger(): Pick<StructuredLogger, 'write'> | undefined;
    recent: {
        list(): Promise<string[]>;
        remember(destination: string): Promise<void>;
    };
    /**
     * Identifies two spellings of one SSH Host (`dev@box` and `dev@box:22`, or two `~/.ssh/config` aliases for the same
     * account) so a second connect focuses its window. Rejects an invalid destination.
     */
    keyOf(destination: string): Promise<string> | string;
    /**
     * Shows this Mac's SSH config file in Finder, for the Connect to SSH Host picker's Open SSH Config action.
     */
    revealSshConfig(): Promise<void>;
}

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
 * Phases in which a connection attempt is running and `remote.cancel` can stop it.
 */
const CANCELLABLE_PHASES = new Set<SshEnvironmentState['phase']>([
    'connecting',
    'probing',
    'installing',
    'starting',
    'reconnecting',
]);

class SshHostEnvironmentController implements SshHostEnvironment {
    private current: SshEnvironmentState;
    private phaseStartedAt = performance.now();
    private readonly prompts: PendingPrompt[] = [];
    private readonly supervisor: SshHostSupervisor;
    private readonly attached = Promise.withResolvers<void>();
    private hasAttached = false;
    private isDisposed = false;
    readonly connection: DesktopServerConnection;
    readonly window: BrowserWindow;
    route: SshHostRendererRoute;
    readonly sendEvent: (event: ServerEvent) => void;

    /**
     * @param destination The destination as the user typed it.
     * @param key The window identity `keyOf` resolved (`user@hostname:port`), which also names the SSH Host the way
     *   `known_hosts` does. It is carried in the state as `hostIdentity` so the Renderer keys its device-local composer
     *   state by the SSH Host rather than by whichever alias opened the window.
     * @param options How this window's connection, supervisor, and window are created.
     */
    constructor(
        readonly destination: string,
        private readonly key: string,
        private readonly options: SshHostEnvironmentsOptions,
    ) {
        this.current = {
            kind: 'ssh',
            destination,
            hostIdentity: key,
            phase: 'connecting',
            needsUserAction: false,
        };
        const parts = options.create(destination, {
            askpass: (request, signal) => this.prompt(request, signal),
            update: (patch) => this.update(patch),
        });
        this.connection = parts.connection;
        this.window = parts.window;
        this.supervisor = parts.supervisor;
        this.sendEvent = parts.sendEvent;
        this.route = {
            ...parts.route,
            window: () => (this.window.isDestroyed() ? undefined : this.window),
        };
        /**
         * Renderer requests issued while the first attachment is still connecting wait on it, like the local window's.
         * The promise rejects when the window closes; marking it handled keeps a window closed before any request from
         * reporting an unhandled rejection.
         */
        // eslint-disable-next-line unicorn/prefer-await -- see comment above
        this.attached.promise.catch(() => {});
        this.connection.onEvent((event) => {
            if (event.event !== 'host.connectionChanged') return;
            if (event.payload.status === 'reconnected')
                this.update({ phase: 'connected', failure: undefined, needsUserAction: false });
            /**
             * `replaced`: the connection stops for good once another Desktop holds the lease; without this the window
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
            if (!this.window.isDestroyed()) {
                if (this.window.isMinimized()) this.window.restore();
                this.window.show();
                this.window.focus();
            }
        });
    }

    private update(patch: SshHostStatePatch): void {
        if (this.isDisposed) return;
        const previous = this.current;
        const next: SshEnvironmentState = { ...previous, ...patch };
        for (const key of Object.keys(patch) as Array<keyof SshHostStatePatch>)
            if (patch[key] === undefined) delete next[key];
        if (next.failure?.reason === 'hostKey' && next.failure.knownHostsName === undefined) {
            const knownHostsName = knownHostsNameOf(this.key);
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
     * Stops a connect, install, or reconnect the user no longer wants. The window stays open on a `cancelled` failure
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
     * Ends the remote Server with its Terminals and Agents, then closes the window: the connection is disposed and a
     * new `remote.connect` starts a fresh Server.
     */
    async stopServer(): Promise<void> {
        this.update({ phase: 'stopped', needsUserAction: false });
        try {
            await this.connection.stopServer();
        } finally {
            if (!this.window.isDestroyed()) this.window.destroy();
        }
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
        this.attached.reject(new CaxriError('CANCELLED', 'The SSH Host window was closed'));
        this.connection.close();
        try {
            await this.supervisor.dispose();
        } catch {
            // Detaching is best effort; the remote Server keeps running regardless.
        }
    }
}

/**
 * An unreadable `~/.ssh/config` or recents file leaves that list empty instead of failing the Connect dialog.
 */
async function emptyOnFailure<T>(read: () => Promise<T[]>): Promise<T[]> {
    try {
        return await read();
    } catch {
        return [];
    }
}

/**
 * Owns every SSH Host window. Each destination has at most one window and one Server connection; IPC from a window is
 * routed to its own environment by the sending `WebContents`.
 */
export function createSshHostEnvironments(options: SshHostEnvironmentsOptions) {
    const environments = new Map<string, SshHostEnvironmentController>();

    function byWebContents(sender: WebContents): SshHostEnvironmentController | undefined {
        for (const environment of environments.values())
            if (!environment.window.isDestroyed() && environment.window.webContents === sender)
                return environment;
        return undefined;
    }

    function focus(environment: SshHostEnvironmentController): void {
        const { window } = environment;
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
    }

    async function reveal(
        existing: SshHostEnvironmentController,
        destination: string,
    ): Promise<void> {
        focus(existing);
        // Another spelling or alias of the same SSH Host: say why this window came forward instead of a new one.
        if (existing.destination !== destination)
            existing.sendEvent({
                event: 'environment.connectionReused',
                payload: { destination },
            });
        if (existing.state().phase === 'failed') await existing.reconnect();
    }

    async function connect(destination: string): Promise<void> {
        /**
         * A window opened for this exact spelling is found without `keyOf`, whose `ssh -G` can take seconds behind a
         * slow `Match exec`; only a spelling no window has used yet pays for resolving it.
         */
        const sameSpelling = environments
            .values()
            .find((environment) => environment.destination === destination);
        if (sameSpelling) return reveal(sameSpelling, destination);
        const key = await options.keyOf(destination);
        // Nothing below awaits until the new environment is registered, so concurrent connects cannot both miss.
        const existing = environments.get(key);
        if (existing) return reveal(existing, destination);
        const environment = new SshHostEnvironmentController(destination, key, options);
        environments.set(key, environment);
        environment.window.once('closed', () => {
            if (environments.get(key) === environment) environments.delete(key);
            // eslint-disable-next-line no-void -- `dispose` never rejects; the remote Server keeps running regardless
            void environment.dispose();
        });
        try {
            await options.recent.remember(destination);
        } catch {
            // A recents file that cannot be written must not block connecting.
        }
        // The window shows the connection progress itself; `remote.connect` returns once the window exists.
        // eslint-disable-next-line no-void -- `start` reports failures through the window's environment state
        void environment.start();
    }

    /**
     * The Main methods one window answers for its own environment. The local Workbench passes `undefined`.
     */
    function methodsFor(
        environment: SshHostEnvironmentController | undefined,
    ): MainEnvironmentMethods {
        return {
            connect,
            get: (): EnvironmentState => environment?.state() ?? { kind: 'local' },
            listHosts: async () => {
                const [hosts, recent] = await Promise.all([
                    emptyOnFailure(() => options.listHosts()),
                    emptyOnFailure(() => options.recent.list()),
                ]);
                return { hosts, recent };
            },
            reconnect: async () => {
                if (!environment)
                    throw new CaxriError('UNAVAILABLE', 'This window is not an SSH Host window');
                await environment.reconnect();
            },
            retryNow: () => {
                if (!environment)
                    throw new CaxriError('UNAVAILABLE', 'This window is not an SSH Host window');
                return environment.retryNow();
            },
            cancel: () => {
                if (!environment)
                    throw new CaxriError('UNAVAILABLE', 'This window is not an SSH Host window');
                environment.cancel();
            },
            revealSshConfig: () => options.revealSshConfig(),
            replyAskpass: (requestId, response) => environment?.reply(requestId, response),
            stopServer: async () => {
                if (!environment)
                    throw new CaxriError('UNAVAILABLE', 'This window is not an SSH Host window');
                await environment.stopServer();
                return { canceled: false };
            },
        };
    }

    return {
        connect,
        /**
         * Main methods for a request from `sender`'s window, or for the local Workbench when `sender` is not an SSH
         * Host window.
         */
        methodsFor: (sender: WebContents | undefined) =>
            methodsFor(sender ? byWebContents(sender) : undefined),
        methodsForEnvironment: (environment: SshHostEnvironment) =>
            methodsFor(
                environment instanceof SshHostEnvironmentController ? environment : undefined,
            ),
        route(sender: WebContents): SshHostRendererRoute | undefined {
            return byWebContents(sender)?.route;
        },
        /**
         * The environment that owns `window`, for menu commands that must act on the focused window's Server.
         */
        forWindow(window: BrowserWindow | undefined): SshHostEnvironment | undefined {
            if (!window) return undefined;
            for (const environment of environments.values())
                if (environment.window === window) return environment;
            return undefined;
        },
        whenAttached(environment: SshHostEnvironment): Promise<void> {
            return environment instanceof SshHostEnvironmentController
                ? environment.whenAttached()
                : Promise.resolve();
        },
        /**
         * Detaches every SSH Host on quit. Remote Servers keep running; only the local Server's quit policy applies.
         */
        async detachAll(): Promise<void> {
            const all = environments.values().toArray();
            environments.clear();
            await Promise.allSettled(all.map((environment) => environment.dispose()));
        },
        /**
         * Asks every attached SSH Host to detach its Terminals before Desktop quits, mirroring the local quit path.
         */
        async detachTerminals(): Promise<void> {
            await Promise.allSettled(
                environments
                    .values()
                    .filter((environment) => environment.state().phase === 'connected')
                    .map((environment) => environment.connection.request('terminal.detachAll')),
            );
        },
        list(): SshHostEnvironment[] {
            return environments.values().toArray();
        },
    };
}

export type SshHostEnvironments = ReturnType<typeof createSshHostEnvironments>;

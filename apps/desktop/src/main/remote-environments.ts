import type {
    EnvironmentState,
    RemoteAskpassRequest,
    RemoteFailureReason,
    ServerDesktopCredential,
    ServerEvent,
    ServerManifest,
    SshEnvironmentState,
    SshHostEntry,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { BrowserWindow, WebContents } from 'electron';

import type { MainEnvironmentMethods } from './main-environment-methods';
import type { DesktopServerSupervisor } from './server-attachment';
import type { DesktopServerConnection } from './server-connection';
import type { RemoteRendererRoute } from './workbench-ipc';

/**
 * The SSH transport below one SSH Host window: it owns the ControlMaster, installs and launches the remote Server, and
 * forwards its endpoint. `DesktopServerConnection` drives it exactly like the local artifact supervisor.
 */
export interface RemoteHostSupervisor extends DesktopServerSupervisor {
    /**
     * The remote Server's manifest (endpoint rewritten to the local forward) and Desktop credential.
     */
    discoverDesktop(): Promise<{ credential: ServerDesktopCredential; manifest: ServerManifest }>;
    /**
     * Clears a failure that stopped automatic retries (`isFailed()`), so the next `ensure` tries again.
     */
    reconnect(): void;
    /**
     * Closes the ControlMaster and the forward. The remote Server keeps running.
     */
    dispose(): Promise<void>;
}

type RemoteStatePatch = Partial<Omit<SshEnvironmentState, 'destination' | 'kind'>>;

/**
 * One SSH Host window and everything it is attached through.
 */
export interface RemoteEnvironment {
    readonly destination: string;
    readonly connection: DesktopServerConnection;
    readonly window: BrowserWindow;
    route: RemoteRendererRoute;
    state(): SshEnvironmentState;
    /**
     * Sends a Server event or Main-originated event to this window only.
     */
    sendEvent: (event: ServerEvent) => void;
}

export interface RemoteEnvironmentParts {
    connection: DesktopServerConnection;
    route: Omit<RemoteRendererRoute, 'window'>;
    sendEvent: (event: ServerEvent) => void;
    supervisor: RemoteHostSupervisor;
    window: BrowserWindow;
}

export interface RemoteEnvironmentHooks {
    /**
     * Shows one OpenSSH prompt in the window and resolves with the user's answer, or `null` when it was cancelled or
     * the helper gave up (`signal`).
     */
    askpass(request: RemoteAskpassRequest, signal: AbortSignal): Promise<string | null>;
    /**
     * The supervisor reports phase, progress, platform, and failures through this.
     */
    update(patch: RemoteStatePatch): void;
}

export interface RemoteEnvironmentsOptions {
    /**
     * Builds the window, supervisor, connection, and transport for one destination. Kept in the composition root
     * because it reuses Main's window chrome, Renderer loading, and Main method wiring.
     */
    create(destination: string, hooks: RemoteEnvironmentHooks): RemoteEnvironmentParts;
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
}

interface PendingPrompt {
    request: RemoteAskpassRequest;
    resolve(response: string | null): void;
}

/**
 * Failure reasons only the user can resolve; automatic reconnection stops at them.
 */
const USER_ACTION_REASONS = new Set<RemoteFailureReason>([
    'authentication',
    'hostKey',
    'cancelled',
]);

class SshEnvironmentController implements RemoteEnvironment {
    private current: SshEnvironmentState;
    private phaseStartedAt = performance.now();
    private readonly prompts: PendingPrompt[] = [];
    private readonly supervisor: RemoteHostSupervisor;
    private readonly attached = Promise.withResolvers<void>();
    private hasAttached = false;
    private isDisposed = false;
    readonly connection: DesktopServerConnection;
    readonly window: BrowserWindow;
    route: RemoteRendererRoute;
    readonly sendEvent: (event: ServerEvent) => void;

    constructor(
        readonly destination: string,
        private readonly options: RemoteEnvironmentsOptions,
    ) {
        this.current = { kind: 'ssh', destination, phase: 'connecting', needsUserAction: false };
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
            if (event.event === 'host.connectionChanged' && event.payload.status === 'reconnected')
                this.update({ phase: 'connected', failure: undefined, needsUserAction: false });
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
        const reason: RemoteFailureReason =
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

    private prompt(request: RemoteAskpassRequest, signal: AbortSignal): Promise<string | null> {
        if (this.isDisposed || signal.aborted) return Promise.resolve(null);
        const startedAt = performance.now();
        return new Promise<string | null>((resolve) => {
            const onAbort = (): void => this.reply(request.requestId, null);
            const settle = (response: string | null): void => {
                signal.removeEventListener('abort', onAbort);
                this.options.logger()?.write('info', logEventCatalog.remoteSsh.askpassPrompted, {
                    durationMs: performance.now() - startedAt,
                    fields: {
                        kind: request.kind,
                        outcome: response === null ? 'cancelled' : 'answered',
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

    private update(patch: RemoteStatePatch): void {
        if (this.isDisposed) return;
        const previous = this.current;
        const next: SshEnvironmentState = { ...previous, ...patch };
        for (const key of Object.keys(patch) as Array<keyof RemoteStatePatch>)
            if (patch[key] === undefined) delete next[key];
        this.current = next;
        if (next.phase !== previous.phase) {
            const now = performance.now();
            this.options
                .logger()
                ?.write(
                    next.phase === 'failed' ? 'warn' : 'info',
                    logEventCatalog.remoteSsh.phaseChanged,
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
            this.markAttached();
        } catch (error) {
            this.fail(error);
        }
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
export function createRemoteEnvironments(options: RemoteEnvironmentsOptions) {
    const environments = new Map<string, SshEnvironmentController>();

    function byWebContents(sender: WebContents): SshEnvironmentController | undefined {
        for (const environment of environments.values())
            if (!environment.window.isDestroyed() && environment.window.webContents === sender)
                return environment;
        return undefined;
    }

    function focus(environment: SshEnvironmentController): void {
        const { window } = environment;
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
    }

    async function connect(destination: string): Promise<void> {
        const key = await options.keyOf(destination);
        // Nothing below awaits until the new environment is registered, so concurrent connects cannot both miss.
        const existing = environments.get(key);
        if (existing) {
            focus(existing);
            // Another spelling or alias of the same SSH Host: say why this window came forward instead of a new one.
            if (existing.destination !== destination)
                existing.sendEvent({
                    event: 'environment.connectionReused',
                    payload: { destination },
                });
            if (existing.state().phase === 'failed') await existing.reconnect();
            return;
        }
        const environment = new SshEnvironmentController(destination, options);
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
    function methodsFor(environment: SshEnvironmentController | undefined): MainEnvironmentMethods {
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
        methodsForEnvironment: (environment: RemoteEnvironment) =>
            methodsFor(environment instanceof SshEnvironmentController ? environment : undefined),
        route(sender: WebContents): RemoteRendererRoute | undefined {
            return byWebContents(sender)?.route;
        },
        /**
         * The environment that owns `window`, for menu commands that must act on the focused window's Server.
         */
        forWindow(window: BrowserWindow | undefined): RemoteEnvironment | undefined {
            if (!window) return undefined;
            for (const environment of environments.values())
                if (environment.window === window) return environment;
            return undefined;
        },
        whenAttached(environment: RemoteEnvironment): Promise<void> {
            return environment instanceof SshEnvironmentController
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
        list(): RemoteEnvironment[] {
            return environments.values().toArray();
        },
    };
}

export type RemoteEnvironments = ReturnType<typeof createRemoteEnvironments>;

import type {
    EnvironmentState,
    ServerDesktopCredential,
    ServerEvent,
    ServerManifest,
    SshEnvironmentState,
    SshHostAskpassRequest,
    SshHostEntry,
} from '@caxri/protocol';
import { CaxriError, detectedSystemOf } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { DesktopServerSupervisor } from '../../connection/server-attachment';
import type { DesktopServerConnection } from '../../connection/server-connection';
import type { MainEnvironmentMethods } from '../../main-environment-methods';
import type { SshHostRendererRoute } from '../../workbench-ipc';
import { SshHostEnvironmentController } from './host-environment-controller';
import type { HostPreferencesStore } from './host-preferences';

/**
 * The SSH transport below one SSH Host environment: it owns the ControlMaster, installs and launches the remote Server,
 * and forwards its endpoint. `DesktopServerConnection` drives it exactly like the local artifact supervisor.
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
     * Ends the attempt on a terminal `updateDeferred` failure until `reconnect()`, after the user chose to keep the SSH
     * Host's Server from another build and its running work.
     */
    deferUpdate(): void;
    /**
     * Closes the ControlMaster and the forward. The remote Server keeps running.
     */
    dispose(): Promise<void>;
}

export type SshHostStatePatch = Partial<
    Omit<SshEnvironmentState, 'destination' | 'hostIdentity' | 'kind'>
>;

/**
 * One connected SSH Host and everything the Workbench window reaches it through. Its `id` is the resolved host
 * identity, which the Renderer names as the `environmentId` of a request meant for this Host.
 */
export interface SshHostEnvironment {
    readonly id: string;
    readonly destination: string;
    readonly connection: DesktopServerConnection;
    route: SshHostRendererRoute;
    state(): SshEnvironmentState;
    /**
     * Sends a Server event or Main-originated event to the Workbench, tagged with this environment.
     */
    sendEvent: (event: ServerEvent) => void;
}

export interface SshHostEnvironmentParts {
    connection: DesktopServerConnection;
    /**
     * Brings the Workbench window forward, for an OpenSSH prompt that needs the user's answer.
     */
    focusWorkbench(): void;
    route: SshHostRendererRoute;
    sendEvent: (event: ServerEvent) => void;
    supervisor: SshHostSupervisor;
    /**
     * Stops listening to the Workbench window; called once the environment is disconnected.
     */
    unbind(): void;
}

export interface SshHostEnvironmentHooks {
    /**
     * Shows one OpenSSH prompt in the Workbench and resolves with the user's answer, or `null` when it was cancelled or
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
     * Builds the supervisor, connection, and transport for one destination. Kept in the composition root because it
     * reuses Main's Workbench window and Main method wiring.
     */
    create(
        destination: string,
        environmentId: string,
        hooks: SshHostEnvironmentHooks,
    ): SshHostEnvironmentParts;
    listHosts(): Promise<SshHostEntry[]>;
    logger(): Pick<StructuredLogger, 'write'> | undefined;
    recent: {
        list(): Promise<string[]>;
        remember(destination: string): Promise<void>;
    };
    /**
     * Identifies two spellings of one SSH Host (`dev@box` and `dev@box:22`, or two `~/.ssh/config` aliases for the same
     * account) so a second connect reuses its connection. Rejects an invalid destination.
     */
    keyOf(destination: string): Promise<string> | string;
    /**
     * Called after any environment's state changes and after one is added or removed, with every current state.
     */
    onEnvironmentsChanged(states: SshEnvironmentState[]): void;
    /**
     * Shows this Mac's SSH config file in Finder, for the Connect to SSH Host picker's Open SSH Config action.
     */
    revealSshConfig(): Promise<void>;
    preferences: HostPreferencesStore;
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
 * Owns every connected SSH Host. Each host identity has at most one environment and one Server connection, because a
 * second connection to one Server would take over its lease. The Workbench names the environment a request is for; see
 * docs/adr/0022-multi-environment-window.md.
 */
export function createSshHostEnvironments(options: SshHostEnvironmentsOptions) {
    const environments = new Map<string, SshHostEnvironmentController>();

    function notifyChanged(): void {
        const states = environments
            .values()
            .map((environment) => environment.state())
            .toArray();
        options.onEnvironmentsChanged(states);
        for (const state of states)
            if (state.phase === 'connected')
                void options.preferences
                    .recordConnected(
                        state.hostIdentity,
                        state.destination,
                        state.platform && detectedSystemOf(state.platform),
                    )
                    .catch(() => {
                        // Preferences are a convenience: a failed write keeps the Host connected and is retried next change.
                    });
    }

    async function reveal(
        existing: SshHostEnvironmentController,
        destination: string,
    ): Promise<string> {
        // Another spelling or alias of the same SSH Host: say why no second connection appeared.
        if (existing.destination !== destination)
            existing.sendEvent({
                event: 'environment.connectionReused',
                payload: { destination },
            });
        if (existing.state().phase === 'failed') await existing.reconnect();
        return existing.id;
    }

    /**
     * Connects `destination`, or reuses the environment already connected to the same SSH Host, and answers its id.
     */
    async function connect(destination: string): Promise<string> {
        /**
         * An environment connected with this exact spelling is found without `keyOf`, whose `ssh -G` can take seconds
         * behind a slow `Match exec`; only a spelling no environment has used yet pays for resolving it.
         */
        const sameSpelling = environments
            .values()
            .find((environment) => environment.destination === destination);
        if (sameSpelling) return reveal(sameSpelling, destination);
        const key = await options.keyOf(destination);
        // Nothing below awaits until the new environment is registered, so concurrent connects cannot both miss.
        const existing = environments.get(key);
        if (existing) return reveal(existing, destination);
        const environment = new SshHostEnvironmentController(
            destination,
            key,
            options,
            notifyChanged,
        );
        environments.set(key, environment);
        notifyChanged();
        try {
            await options.recent.remember(destination);
        } catch {
            // A recents file that cannot be written must not block connecting.
        }
        // The Workbench shows the connection progress itself; `sshHost.connect` returns once the environment exists.
        void environment.start();
        return key;
    }

    /**
     * Detaches one SSH Host without stopping its Server: its Terminals and Agents keep running there.
     */
    async function disconnect(id: string): Promise<void> {
        const environment = environments.get(id);
        if (!environment) return;
        environments.delete(id);
        notifyChanged();
        await environment.dispose();
    }

    function requireEnvironment(environment: SshHostEnvironmentController | undefined) {
        if (!environment) throw new CaxriError('UNAVAILABLE', 'The SSH Host is not connected');
        return environment;
    }

    /**
     * The Main methods answered for one environment: an SSH Host for a request that named it, or the local Server
     * (`undefined`).
     */
    function methodsFor(
        environment: SshHostEnvironmentController | undefined,
    ): MainEnvironmentMethods {
        return {
            connect,
            disconnect: async () => {
                await disconnect(requireEnvironment(environment).id);
            },
            get: (): EnvironmentState => environment?.state() ?? { kind: 'local' },
            list: () =>
                environments
                    .values()
                    .map((each) => each.state())
                    .toArray(),
            listHosts: async () => {
                const [hosts, recent] = await Promise.all([
                    emptyOnFailure(() => options.listHosts()),
                    emptyOnFailure(() => options.recent.list()),
                ]);
                return { hosts, recent };
            },
            reconnect: async () => {
                await requireEnvironment(environment).reconnect();
            },
            retryNow: () => requireEnvironment(environment).retryNow(),
            cancel: () => {
                requireEnvironment(environment).cancel();
            },
            revealSshConfig: () => options.revealSshConfig(),
            replyAskpass: (requestId, response) => environment?.reply(requestId, response),
            preferences: {
                get: () => options.preferences.read(),
                update: (hostId, change) => options.preferences.update(hostId, change),
                setShowHostNames: (shouldShowHostNames) =>
                    options.preferences.setShowHostNames(shouldShowHostNames),
            },
            stopServer: async () => {
                const target = requireEnvironment(environment);
                try {
                    await target.stopServer();
                } finally {
                    await disconnect(target.id);
                }
                return { canceled: false };
            },
        };
    }

    return {
        connect,
        disconnect,
        methodsFor: (environmentId: string | undefined) =>
            methodsFor(environmentId === undefined ? undefined : environments.get(environmentId)),
        methodsForEnvironment: (environment: SshHostEnvironment) =>
            methodsFor(
                environment instanceof SshHostEnvironmentController ? environment : undefined,
            ),
        /**
         * The request route of a connected environment, or `undefined` for an unknown or disconnected one, which the
         * caller must refuse rather than send to the local Server.
         */
        route(environmentId: string): SshHostRendererRoute | undefined {
            return environments.get(environmentId)?.route;
        },
        get(environmentId: string): SshHostEnvironment | undefined {
            return environments.get(environmentId);
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

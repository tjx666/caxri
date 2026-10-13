import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

import { ServerClient } from '@caxri/client/supervise';
import type {
    RemoteConnectionPhase,
    ServerDesktopCredential,
    ServerManifest,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { DesktopServerSupervisor } from '../server-attachment';
import { AskpassBridge } from './askpass';
import type { SshDestination } from './destination';
import { parseSshDestination } from './destination';
import { validateRemoteProbe } from './remote-host-requirements';
import { installRemoteBuild } from './remote-install';
import { parseLaunchOutput } from './remote-launch-output';
import type { RemoteArchitecture, RemoteLayer } from './remote-layers';
import { readRemoteLayer } from './remote-layers';
import type { RemoteProbe, SeedableConfigFile } from './remote-scripts';
import {
    launchScript,
    parseProbe,
    probeScript,
    seedConfigScript,
    stopWaitScript,
} from './remote-scripts';
import type {
    RemoteSeedConfig,
    RemoteServerSupervisorOptions,
    RemoteStateUpdate,
} from './remote-server-supervisor-options';
import type { RemoteFailure, RemoteTransport } from './remote-setup';
import {
    bestEffort,
    CANCELLED_FAILURE,
    lastLine,
    RemoteSetupError,
    runRemoteScript,
    TERMINAL_REASONS,
    toFailure,
    USER_ACTION_REASONS,
} from './remote-setup';
import type { SshConnectionCloseInfo, SshConnectionOptions } from './ssh-connection';
import { SshConnection } from './ssh-connection';

const PROBE_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 45_000;
const SMALL_SCRIPT_TIMEOUT_MS = 30_000;

interface AttachTarget {
    credential: ServerDesktopCredential;
    /**
     * Discovery manifest with its endpoint rewritten to the local forward.
     */
    manifest: ServerManifest;
    remotePid: number;
}

/**
 * Supervises the Server on one SSH Host for `DesktopServerConnection`. `ensure()` connects (or reuses) the
 * ControlMaster, probes the host, installs the application layer when missing, adopts or starts the remote Server,
 * forwards its loopback endpoint, and returns an operator client attached through the forward. Everything after that is
 * the same code path as a local Server.
 *
 * A lost master clears every cached remote fact and reports `reconnecting`; the WebSockets through the forward close
 * with it, so `DesktopServerConnection`'s existing reconnect loop calls `ensure()` again, which starts a new master.
 */
export class RemoteServerSupervisor implements DesktopServerSupervisor {
    private askpass?: Pick<AskpassBridge, 'beginAttempt' | 'close' | 'environment'>;
    private connection?: RemoteTransport;
    /**
     * The master whose `start()` is still waiting for OpenSSH, so `cancel()` can stop it before it is ready.
     */
    private pendingConnection?: RemoteTransport;
    /**
     * Automatic attempts since an attached connection dropped, reported as `attempt` while `reconnecting`.
     */
    private reconnectAttempt = 0;
    /**
     * Set by `cancel()` until the next `reconnect()`, so the failure an interrupted step raises is reported as the
     * user's cancellation rather than as whatever stopping the master made that step see.
     */
    private isCancelled = false;
    private connectionOpenedAt = 0;
    private current?: AttachTarget;
    private forward?: { localPort: number; remotePort: number };
    private hasAttached = false;
    private isDisposed = false;
    private platform?: RemoteStateUpdate['platform'];
    private probe?: RemoteProbe;
    private setup?: Promise<AttachTarget>;
    private terminalFailure?: RemoteSetupError;
    private readonly destination: SshDestination;

    constructor(private readonly options: RemoteServerSupervisorOptions) {
        this.destination = parseSshDestination(options.destination);
    }

    private emit(
        phase: RemoteConnectionPhase,
        extra: Partial<Omit<RemoteStateUpdate, 'phase'>> = {},
    ): void {
        // Every key is present so a patch-merging consumer clears a previous phase's failure or progress.
        this.options.onState({
            phase,
            attempt: undefined,
            failure: undefined,
            progress: undefined,
            needsUserAction: false,
            ...(this.platform && { platform: this.platform }),
            ...extra,
        });
    }

    /**
     * Shares one setup between concurrent `ensure()` calls and clears it once settled so the next call starts fresh.
     */
    private async sharedSetup(): Promise<AttachTarget> {
        try {
            return await this.runSetup();
        } finally {
            this.setup = undefined;
        }
    }

    private async runSetup(): Promise<AttachTarget> {
        let phase: RemoteConnectionPhase = this.hasAttached ? 'reconnecting' : 'connecting';
        try {
            if (this.hasAttached) {
                this.reconnectAttempt += 1;
                this.emit(phase, { attempt: this.reconnectAttempt });
            } else this.emit(phase);
            const connection = await this.ensureConnection();
            phase = 'probing';
            this.emit(phase);
            const layers = await this.readLayers();
            const probe = await this.ensureProbe(connection, layers);
            const layer = layers.get(probe.architecture as RemoteArchitecture);
            if (!layer)
                throw new RemoteSetupError(
                    'installFailed',
                    `This Caxri build has no remote Server for linux-${probe.architecture}`,
                );
            if (!probe.builds.has(layer.descriptor.buildId)) {
                phase = 'installing';
                await this.install(connection, probe, layer);
            }
            if (this.options.seedConfig && !probe.configPresent) await this.seed(connection);
            phase = 'starting';
            this.emit(phase);
            const launched = await this.launch(connection, layer);
            const localPort = await this.ensureForward(connection, launched.manifest.endpoint.port);
            this.current = {
                credential: launched.credential,
                manifest: {
                    ...launched.manifest,
                    endpoint: { ...launched.manifest.endpoint, port: localPort },
                },
                remotePid: launched.manifest.pid,
            };
            this.hasAttached = true;
            return this.current;
        } catch (error) {
            throw this.fail(error, phase);
        }
    }

    private fail(error: unknown, phase: RemoteConnectionPhase): RemoteSetupError {
        const failure: RemoteFailure = this.isCancelled ? CANCELLED_FAILURE : toFailure(error);
        this.options.logger.write('warn', logEventCatalog.remoteSsh.attachFailed, {
            fields: { phase, reason: failure.reason },
        });
        const setupError =
            error instanceof RemoteSetupError && error.reason === failure.reason
                ? error
                : new RemoteSetupError(failure.reason, failure.message, failure.holder);
        const isTerminal = TERMINAL_REASONS.has(failure.reason);
        if (isTerminal) this.terminalFailure = setupError;
        if (this.isDisposed) return setupError;
        /**
         * After the window has been attached once, `DesktopServerConnection`'s reconnect loop retries a failure that is
         * not terminal on its own, so the window keeps saying it is reconnecting (with the cause) instead of claiming
         * the connection gave up between two attempts.
         */
        if (!isTerminal && this.hasAttached)
            this.emit('reconnecting', {
                attempt: this.reconnectAttempt,
                failure,
            });
        else
            this.emit('failed', {
                failure,
                needsUserAction: USER_ACTION_REASONS.has(failure.reason),
            });
        return setupError;
    }

    private forgetRemoteState(): void {
        this.probe = undefined;
        this.forward = undefined;
        this.current = undefined;
    }

    /**
     * The error an `ensure()` must raise when `cancel()` or `dispose()` ran while it awaited the handshake. A method
     * rather than an inline check because the flags change across that `await`, which control-flow narrowing misses.
     */
    private stoppedDuringHandshake(): Error | undefined {
        if (this.isDisposed) return new CaxriError('CANCELLED', 'SSH Host connection was closed');
        if (this.isCancelled) return new RemoteSetupError('cancelled', CANCELLED_FAILURE.message);
        return undefined;
    }

    private async ensureAskpass(): Promise<Record<string, string>> {
        if (this.askpass) return this.askpass.environment();
        const askpass = await (
            this.options.createAskpass ??
            (() =>
                AskpassBridge.create({
                    directory: this.options.privateDirectory,
                    electronExecutable: this.options.electronExecutable,
                    handler: this.options.askpass,
                }))
        )();
        if (this.isDisposed) {
            await bestEffort(() => askpass.close());
            throw new CaxriError('CANCELLED', 'SSH Host connection was closed');
        }
        this.askpass = askpass;
        return askpass.environment();
    }

    private async ensureConnection(): Promise<RemoteTransport> {
        if (this.connection?.isOpen) return this.connection;
        const stale = this.connection;
        this.connection = undefined;
        this.forgetRemoteState();
        if (stale) await bestEffort(() => stale.stop());
        const transportOptions: SshConnectionOptions = {
            controlDirectory: this.options.privateDirectory,
            destination: this.destination,
            environment: await this.ensureAskpass(),
            ...(this.options.configFile !== undefined && { configFile: this.options.configFile }),
            ...(this.options.sshExecutable !== undefined && {
                sshExecutable: this.options.sshExecutable,
            }),
        };
        const connection =
            this.options.createTransport?.(transportOptions) ?? new SshConnection(transportOptions);
        const startedAt = Date.now();
        this.askpass?.beginAttempt();
        this.pendingConnection = connection;
        try {
            await connection.start();
        } finally {
            if (this.pendingConnection === connection) this.pendingConnection = undefined;
        }
        if (this.isDisposed || this.isCancelled) {
            await connection.stop();
            throw new CaxriError('CANCELLED', 'SSH Host connection was closed');
        }
        this.options.logger.write('info', logEventCatalog.remoteSsh.masterReady, {
            fields: { durationMs: Date.now() - startedAt },
        });
        this.connection = connection;
        this.connectionOpenedAt = Date.now();
        connection.onClose((info) => this.handleConnectionClosed(connection, info));
        return connection;
    }

    private handleConnectionClosed(
        connection: RemoteTransport,
        info: SshConnectionCloseInfo,
    ): void {
        if (this.connection !== connection) return;
        this.connection = undefined;
        this.forgetRemoteState();
        this.options.logger.write('warn', logEventCatalog.remoteSsh.masterClosed, {
            fields: {
                exitCode: info.code,
                signal: info.signal,
                uptimeMs: Date.now() - this.connectionOpenedAt,
                wasReady: true,
            },
        });
        if (this.isDisposed) return;
        this.emit('reconnecting', {
            failure: { message: info.message || 'SSH connection closed', reason: 'connectionLost' },
        });
    }

    private async readLayers(): Promise<Map<RemoteArchitecture, RemoteLayer>> {
        const layers = new Map<RemoteArchitecture, RemoteLayer>();
        const architectures = ['x64', 'arm64'] as const;
        const settled = await Promise.allSettled(
            architectures.map((architecture) =>
                readRemoteLayer(this.options.remoteLayersRoot, architecture),
            ),
        );
        // A build may carry only one architecture; the probe decides whether the missing one matters.
        for (const [index, outcome] of settled.entries())
            if (outcome.status === 'fulfilled')
                layers.set(architectures[index] ?? 'x64', outcome.value);
        return layers;
    }

    private async ensureProbe(
        connection: RemoteTransport,
        layers: Map<RemoteArchitecture, RemoteLayer>,
    ): Promise<RemoteProbe> {
        if (this.probe) return this.probe;
        const startedAt = Date.now();
        const descriptors = Array.from(layers.values(), (layer) => layer.descriptor);
        const script = probeScript({
            buildIds: descriptors.map((descriptor) => descriptor.buildId),
            runtimeSha256s: descriptors.map((descriptor) => descriptor.runtime.sha256),
        });
        const { result, stderr } = await runRemoteScript(connection, script, {
            timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (!result) {
            if (/base64/iu.test(stderr) && /not found|no such file/iu.test(stderr))
                throw new RemoteSetupError('missingTool', 'The SSH Host has no "base64" command');
            throw new RemoteSetupError(
                'unknown',
                lastLine(stderr) || 'Could not inspect the SSH Host',
            );
        }
        const probe = parseProbe(result);
        if (probe.architecture === 'x64' || probe.architecture === 'arm64')
            this.platform = {
                architecture: probe.architecture,
                glibc: probe.glibc.slice(0, 32),
                hostname: probe.hostname,
            };
        const layer = layers.get(probe.architecture as RemoteArchitecture);
        validateRemoteProbe(probe, layer?.descriptor.glibcBaseline);
        this.options.logger.write('info', logEventCatalog.remoteSsh.probed, {
            fields: {
                architecture: probe.architecture,
                durationMs: Date.now() - startedAt,
                glibc: probe.glibc.slice(0, 32),
                hasBuild: layer ? probe.builds.has(layer.descriptor.buildId) : false,
                hasServer: probe.server !== undefined,
            },
        });
        this.probe = probe;
        return probe;
    }

    private async install(
        connection: RemoteTransport,
        probe: RemoteProbe,
        layer: RemoteLayer,
    ): Promise<void> {
        const installed = await installRemoteBuild({
            connection,
            layer,
            logger: this.options.logger,
            onProgress: (progress) => this.emit('installing', { progress }),
            probe,
            runtimeCacheDirectory: this.options.runtimeCacheDirectory,
        });
        // A master lost during cleanup already cleared every cached fact; do not resurrect a stale probe.
        if (this.connection === connection) this.probe = installed;
    }

    /**
     * Copies Desktop's config into a remote profile that has none yet, so the first remote window looks like the local
     * one. Failures are ignored: the remote Server creates defaults on its own.
     */
    private async seed(connection: RemoteTransport): Promise<void> {
        let seed: RemoteSeedConfig = {};
        await bestEffort(async () => {
            seed = (await this.options.seedConfig?.()) ?? {};
        });
        const files: Array<[SeedableConfigFile, string | undefined]> = [
            ['settings.jsonc', seed.settings],
            ['keybindings.jsonc', seed.keybindings],
            ['theme.json', seed.theme],
        ];
        // Each file is its own channel on the shared master, so the three writes run concurrently.
        await Promise.all(
            files
                .filter((entry): entry is [SeedableConfigFile, string] => entry[1] !== undefined)
                .map(([file, content]) =>
                    bestEffort(() =>
                        runRemoteScript(connection, seedConfigScript({ file }), {
                            stdin: Readable.from([Buffer.from(content, 'utf8')]),
                            timeoutMs: SMALL_SCRIPT_TIMEOUT_MS,
                        }),
                    ),
                ),
        );
        if (this.probe) this.probe = { ...this.probe, configPresent: true };
    }

    private async launch(
        connection: RemoteTransport,
        layer: RemoteLayer,
    ): Promise<{ credential: ServerDesktopCredential; manifest: ServerManifest }> {
        const startedAt = Date.now();
        const { result, stderr } = await runRemoteScript(
            connection,
            launchScript({
                buildId: layer.descriptor.buildId,
                ...(this.options.inspect === true && { inspect: true }),
            }),
            { timeoutMs: LAUNCH_TIMEOUT_MS },
        );
        const { credential, manifest, outcome } = parseLaunchOutput(result, stderr);
        this.options.logger.write('info', logEventCatalog.remoteSsh.launched, {
            fields: { durationMs: Date.now() - startedAt, outcome },
        });
        return { credential, manifest };
    }

    private async ensureForward(connection: RemoteTransport, remotePort: number): Promise<number> {
        if (this.forward?.remotePort === remotePort) return this.forward.localPort;
        const previous = this.forward;
        this.forward = undefined;
        if (previous) await bestEffort(() => connection.cancelForward(previous.localPort));
        const startedAt = Date.now();
        const localPort = await connection.forwardLocal(remotePort);
        this.forward = { localPort, remotePort };
        this.options.logger.write('info', logEventCatalog.remoteSsh.forwarded, {
            fields: { durationMs: Date.now() - startedAt },
        });
        return localPort;
    }

    isFailed(): boolean {
        return this.terminalFailure !== undefined;
    }

    /**
     * Remote Servers have no local restart budget; the reconnect loop owns retries, so lifecycle events never fire.
     */
    onLifecycle(): () => void {
        return () => {};
    }

    releaseProcess(pid: number): void {
        if (this.current?.remotePid === pid) this.current = undefined;
    }

    /**
     * Liveness of a remote pid cannot be checked synchronously, so a loss never consumes restart budget; the next
     * `ensure()` relaunches the Server if it died.
     */
    reportProcessLoss(): boolean {
        return false;
    }

    /**
     * Clears a failure that stopped automatic reconnection, typically after the user chose Reconnect.
     */
    reconnect(): void {
        this.terminalFailure = undefined;
        this.isCancelled = false;
        this.reconnectAttempt = 0;
    }

    /**
     * Stops the attempt in flight at the user's request. Stopping the ControlMaster (or the one still starting) ends
     * every probe, upload, and launch running through it, so the step in progress fails at once; the failure stays
     * terminal until `reconnect()`, which also ends `DesktopServerConnection`'s reconnect loop at its next check.
     */
    cancel(): void {
        if (this.isDisposed) return;
        this.isCancelled = true;
        this.terminalFailure = new RemoteSetupError('cancelled', CANCELLED_FAILURE.message);
        const connections = [this.connection, this.pendingConnection];
        this.connection = undefined;
        this.pendingConnection = undefined;
        this.forgetRemoteState();
        for (const connection of connections)
            // eslint-disable-next-line no-void -- best effort; the step using the master fails as cancelled either way
            if (connection) void bestEffort(() => connection.stop());
        // The window logs the phase change with its `cancelled` reason; a step this interrupted logs `attachFailed`.
        this.emit('failed', { failure: CANCELLED_FAILURE });
    }

    async ensure(timeoutMs = 15_000): Promise<ServerClient> {
        if (this.isDisposed) throw new CaxriError('CANCELLED', 'SSH Host connection was closed');
        if (this.terminalFailure) throw this.terminalFailure;
        this.setup ??= this.sharedSetup();
        const target = await this.setup;
        // A cancel that lands after setup finished but before the handshake still wins over attaching.
        if (this.isCancelled) throw new RemoteSetupError('cancelled', CANCELLED_FAILURE.message);
        const connect =
            this.options.connectOperator ??
            ((manifest: ServerManifest, timeout: number) =>
                ServerClient.connect(manifest, timeout, { kind: 'operator' }));
        try {
            const client = await connect(target.manifest, timeoutMs);
            /**
             * `cancel()` (or `dispose()`) can land while the operator handshake is in flight. It already reported the
             * attempt as failed, so attaching now would flip the window back to `connected` over a terminal
             * cancellation. Close the client the handshake produced instead of handing it out.
             */
            const stopped = this.stoppedDuringHandshake();
            if (stopped) {
                client.close({ cancelPendingRequests: true });
                throw stopped;
            }
            this.reconnectAttempt = 0;
            this.emit('connected');
            return client;
        } catch (error) {
            // The Server may have exited after launch printed its manifest; relaunch on the next attempt.
            this.current = undefined;
            throw error;
        }
    }

    /**
     * Discovery documents of the attached remote Server, with the manifest endpoint pointing at the local forward.
     */
    discoverDesktop(): Promise<{ credential: ServerDesktopCredential; manifest: ServerManifest }> {
        if (!this.current)
            return Promise.reject(
                new CaxriError('NOT_FOUND', 'No remote Caxri Host is attached for this SSH Host'),
            );
        return Promise.resolve({
            credential: this.current.credential,
            manifest: this.current.manifest,
        });
    }

    /**
     * Waits until a remote Server pid exits, so a relaunch cannot race the old manifest. Like the local wait, a timeout
     * or a closed connection simply returns; the next `ensure()` adopts whatever is running.
     */
    async waitForExit(pid: number, timeoutMs: number): Promise<void> {
        if (this.current?.remotePid === pid) this.current = undefined;
        const connection = this.connection;
        if (!connection?.isOpen) return;
        const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
        await bestEffort(() =>
            runRemoteScript(connection, stopWaitScript({ pid, timeoutSeconds }), {
                timeoutMs: timeoutMs + 10_000,
            }),
        );
    }

    /**
     * Closes the ControlMaster and its forward. The remote Server keeps running (closing a window only detaches).
     */
    async dispose(): Promise<void> {
        if (this.isDisposed) return;
        this.isDisposed = true;
        const connection = this.connection;
        const askpass = this.askpass;
        this.connection = undefined;
        this.askpass = undefined;
        this.forgetRemoteState();
        if (connection) await bestEffort(() => connection.stop());
        if (askpass) await bestEffort(() => askpass.close());
        this.emit('disconnected');
    }
}

import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

import { ServerClient } from '@caxri/client/supervise';
import type {
    ServerDesktopCredential,
    ServerManifest,
    SshHostConnectionPhase,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { logEventCatalog } from '@caxri/system';

import type { DesktopServerSupervisor } from '../server-attachment';
import { AskpassBridge } from './askpass';
import type { SshDestination } from './destination';
import { parseSshDestination } from './destination';
import { remoteTargetOf, validateSshHostProbe } from './host-requirements';
import { installSshHostBuild } from './install';
import { parseLaunchOutput } from './launch-output';
import type { RemoteLayer, RemoteTarget } from './layers';
import { readRemoteLayer, REMOTE_TARGETS } from './layers';
import type { SeedableConfigFile, SshHostProbe } from './scripts';
import { launchScript, parseProbe, probeScript, seedConfigScript, stopWaitScript } from './scripts';
import type {
    SshHostSeedConfig,
    SshHostServerSupervisorOptions,
    SshHostStateUpdate,
} from './server-supervisor-options';
import type { SshHostFailure, SshHostTransport } from './setup';
import {
    bestEffort,
    CANCELLED_FAILURE,
    lastLine,
    runSshHostScript,
    SshHostSetupError,
    TERMINAL_REASONS,
    toFailure,
    USER_ACTION_REASONS,
} from './setup';
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
export class SshHostServerSupervisor implements DesktopServerSupervisor {
    private askpass?: Pick<AskpassBridge, 'beginAttempt' | 'close' | 'environment'>;
    private connection?: SshHostTransport;
    /**
     * The master whose `start()` is still waiting for OpenSSH, so `cancel()` can stop it before it is ready.
     */
    private pendingConnection?: SshHostTransport;
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
    private platform?: SshHostStateUpdate['platform'];
    private probe?: SshHostProbe;
    private setup?: Promise<AttachTarget>;
    private terminalFailure?: SshHostSetupError;
    private readonly destination: SshDestination;

    constructor(private readonly options: SshHostServerSupervisorOptions) {
        this.destination = parseSshDestination(options.destination);
    }

    private emit(
        phase: SshHostConnectionPhase,
        extra: Partial<Omit<SshHostStateUpdate, 'phase'>> = {},
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
        let phase: SshHostConnectionPhase = this.hasAttached ? 'reconnecting' : 'connecting';
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
            const target = remoteTargetOf(probe);
            const layer = target && layers.get(target);
            if (!layer)
                throw new SshHostSetupError(
                    'installFailed',
                    `This Caxri build has no remote Server for ${target ?? `${probe.os} ${probe.architecture}`}`,
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

    private fail(error: unknown, phase: SshHostConnectionPhase): SshHostSetupError {
        const failure: SshHostFailure = this.isCancelled ? CANCELLED_FAILURE : toFailure(error);
        this.options.logger.write('warn', logEventCatalog.sshHost.attachFailed, {
            fields: { phase, reason: failure.reason },
        });
        const setupError =
            error instanceof SshHostSetupError && error.reason === failure.reason
                ? error
                : new SshHostSetupError(failure.reason, failure.message, failure.holder);
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
        if (this.isCancelled) return new SshHostSetupError('cancelled', CANCELLED_FAILURE.message);
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

    private async ensureConnection(): Promise<SshHostTransport> {
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
        this.options.logger.write('info', logEventCatalog.sshHost.masterReady, {
            fields: { durationMs: Date.now() - startedAt },
        });
        this.connection = connection;
        this.connectionOpenedAt = Date.now();
        connection.onClose((info) => this.handleConnectionClosed(connection, info));
        return connection;
    }

    private handleConnectionClosed(
        connection: SshHostTransport,
        info: SshConnectionCloseInfo,
    ): void {
        if (this.connection !== connection) return;
        this.connection = undefined;
        this.forgetRemoteState();
        this.options.logger.write('warn', logEventCatalog.sshHost.masterClosed, {
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

    private async readLayers(): Promise<Map<RemoteTarget, RemoteLayer>> {
        const layers = new Map<RemoteTarget, RemoteLayer>();
        const settled = await Promise.allSettled(
            REMOTE_TARGETS.map((target) => readRemoteLayer(this.options.remoteLayersRoot, target)),
        );
        // A build may carry only some targets; the probe decides whether a missing one matters.
        for (const outcome of settled)
            if (outcome.status === 'fulfilled')
                layers.set(outcome.value.descriptor.target, outcome.value);
        return layers;
    }

    private async ensureProbe(
        connection: SshHostTransport,
        layers: Map<RemoteTarget, RemoteLayer>,
    ): Promise<SshHostProbe> {
        if (this.probe) return this.probe;
        const startedAt = Date.now();
        const descriptors = Array.from(layers.values(), (layer) => layer.descriptor);
        const script = probeScript({
            buildIds: descriptors.map((descriptor) => descriptor.buildId),
            runtimeSha256s: descriptors.map((descriptor) => descriptor.runtime.sha256),
        });
        const { result, stderr } = await runSshHostScript(connection, script, {
            timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (!result) {
            if (/base64/iu.test(stderr) && /not found|no such file/iu.test(stderr))
                throw new SshHostSetupError('missingTool', 'The SSH Host has no "base64" command');
            throw new SshHostSetupError(
                'unknown',
                lastLine(stderr) || 'Could not inspect the SSH Host',
            );
        }
        const probe = parseProbe(result);
        const target = remoteTargetOf(probe);
        const isMacos = probe.os === 'Darwin';
        const systemVersion = (isMacos ? probe.macos : probe.glibc).slice(0, 32);
        if (
            (isMacos || probe.os === 'Linux') &&
            (probe.architecture === 'x64' || probe.architecture === 'arm64')
        )
            this.platform = {
                architecture: probe.architecture,
                hostname: probe.hostname,
                system: isMacos ? 'macos' : 'linux',
                systemVersion,
            };
        const layer = target && layers.get(target);
        validateSshHostProbe(probe, layer?.descriptor.systemBaseline);
        this.options.logger.write('info', logEventCatalog.sshHost.probed, {
            fields: {
                architecture: probe.architecture,
                durationMs: Date.now() - startedAt,
                os: probe.os.slice(0, 32),
                systemVersion,
                hasBuild: layer ? probe.builds.has(layer.descriptor.buildId) : false,
                hasServer: probe.server !== undefined,
            },
        });
        this.probe = probe;
        return probe;
    }

    private async install(
        connection: SshHostTransport,
        probe: SshHostProbe,
        layer: RemoteLayer,
    ): Promise<void> {
        const installed = await installSshHostBuild({
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
    private async seed(connection: SshHostTransport): Promise<void> {
        let seed: SshHostSeedConfig = {};
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
                        runSshHostScript(connection, seedConfigScript({ file }), {
                            stdin: Readable.from([Buffer.from(content, 'utf8')]),
                            timeoutMs: SMALL_SCRIPT_TIMEOUT_MS,
                        }),
                    ),
                ),
        );
        if (this.probe) this.probe = { ...this.probe, configPresent: true };
    }

    private async launch(
        connection: SshHostTransport,
        layer: RemoteLayer,
    ): Promise<{ credential: ServerDesktopCredential; manifest: ServerManifest }> {
        const startedAt = Date.now();
        const { result, stderr } = await runSshHostScript(
            connection,
            launchScript({
                buildId: layer.descriptor.buildId,
                ...(this.options.inspect === true && { inspect: true }),
            }),
            { timeoutMs: LAUNCH_TIMEOUT_MS },
        );
        const { credential, manifest, outcome } = parseLaunchOutput(result, stderr);
        this.options.logger.write('info', logEventCatalog.sshHost.launched, {
            fields: { durationMs: Date.now() - startedAt, outcome },
        });
        return { credential, manifest };
    }

    private async ensureForward(connection: SshHostTransport, remotePort: number): Promise<number> {
        if (this.forward?.remotePort === remotePort) return this.forward.localPort;
        const previous = this.forward;
        this.forward = undefined;
        if (previous) await bestEffort(() => connection.cancelForward(previous.localPort));
        const startedAt = Date.now();
        const localPort = await connection.forwardLocal(remotePort);
        this.forward = { localPort, remotePort };
        this.options.logger.write('info', logEventCatalog.sshHost.forwarded, {
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
        this.terminalFailure = new SshHostSetupError('cancelled', CANCELLED_FAILURE.message);
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
        if (this.isCancelled) throw new SshHostSetupError('cancelled', CANCELLED_FAILURE.message);
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
            runSshHostScript(connection, stopWaitScript({ pid, timeoutSeconds }), {
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

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { ServerClient } from '@caxri/client/supervise';
import type { ServerManifest } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteStateUpdate } from '../remote-server-supervisor';
import { RemoteServerSupervisor } from '../remote-server-supervisor';
import { RemoteSetupError } from '../remote-setup';
import { SshConnectionError } from '../ssh-connection';
import type { LayerFixture } from './support/remote-fixtures';
import {
    buildLayerFixture,
    captureRejection,
    hostEnvironment,
    killRemoteServer,
    linuxShims,
    LocalTransport,
    makeShortTemporaryDirectory,
    writeShims,
} from './support/remote-fixtures';

const REMOTE_PORT = 45_678;

describe('remote server supervisor', () => {
    let root: string;
    let home: string;
    let shims: string;
    let layers: string;
    let fixture: LayerFixture;
    let states: RemoteStateUpdate[];
    let transports: LocalTransport[];
    let startFailure: Error | undefined;
    let logger: { write: ReturnType<typeof vi.fn<StructuredLogger['write']>> };
    let operatorManifests: ServerManifest[];
    let operatorFailure: Error | undefined;

    beforeEach(async () => {
        root = await makeShortTemporaryDirectory('sup');
        home = join(root, 'home');
        shims = join(root, 'shims');
        layers = join(root, 'layers');
        await mkdir(home);
        await writeShims(shims, linuxShims());
        fixture = await buildLayerFixture(layers, { remotePort: REMOTE_PORT });
        // Pre-populate Desktop's runtime cache so the upload fallback needs no network.
        const cached = join(root, 'runtimes', fixture.descriptor.runtime.sha256);
        await mkdir(cached, { recursive: true });
        await writeFile(join(cached, 'node'), fixture.runtimeContent, { mode: 0o755 });
        states = [];
        transports = [];
        startFailure = undefined;
        logger = { write: vi.fn<StructuredLogger['write']>() };
        operatorManifests = [];
        operatorFailure = undefined;
    });

    afterEach(async () => {
        await killRemoteServer(home);
        await rm(root, { force: true, recursive: true });
    });

    function createSupervisor(
        overrides: Partial<ConstructorParameters<typeof RemoteServerSupervisor>[0]> = {},
    ): RemoteServerSupervisor {
        return new RemoteServerSupervisor({
            askpass: () => Promise.resolve(null),
            connectOperator: (manifest) => {
                operatorManifests.push(manifest);
                if (operatorFailure) return Promise.reject(operatorFailure);
                return Promise.resolve({} as ServerClient);
            },
            createAskpass: () =>
                Promise.resolve({
                    beginAttempt: () => {},
                    close: () => Promise.resolve(),
                    environment: () => ({}),
                }),
            createTransport: () => {
                const transport = new LocalTransport(hostEnvironment(home, shims), startFailure);
                transports.push(transport);
                return transport;
            },
            destination: 'dev@lab',
            electronExecutable: process.execPath,
            logger,
            onState: (update) => states.push(update),
            privateDirectory: join(root, 'ctl'),
            remoteLayersRoot: layers,
            runtimeCacheDirectory: join(root, 'runtimes'),
            ...overrides,
        });
    }

    const phases = (): string[] =>
        states.map((state) => state.phase).filter((phase, index, all) => phase !== all[index - 1]);

    const loggedEvents = (): string[] => logger.write.mock.calls.map((call) => call[1] as string);

    describe('RemoteServerSupervisor', () => {
        it('installs, starts, forwards, and attaches on a fresh SSH Host', async () => {
            const supervisor = createSupervisor();
            await supervisor.ensure();

            expect(phases()).toEqual([
                'connecting',
                'probing',
                'installing',
                'starting',
                'connected',
            ]);
            const installing = states.filter((state) => state.phase === 'installing');
            const total = fixture.descriptor.app.bytes + fixture.descriptor.runtime.bytes;
            expect(installing.at(-1)?.progress).toEqual({
                completedBytes: total,
                totalBytes: total,
            });
            expect(states.at(-1)).toMatchObject({
                failure: undefined,
                needsUserAction: false,
                phase: 'connected',
                platform: { architecture: 'x64', glibc: '2.36', hostname: 'test-host' },
            });

            const { credential, manifest } = await supervisor.discoverDesktop();
            expect(manifest.endpoint.port).toBe(REMOTE_PORT + 1000);
            expect(credential.processIdentity).toBe(manifest.processIdentity);
            expect(operatorManifests[0]).toEqual(manifest);
            expect(transports[0]?.forwards).toEqual([REMOTE_PORT]);
            expect(
                await readFile(
                    join(
                        home,
                        '.caxri-server/builds',
                        fixture.descriptor.buildId,
                        '.caxri-complete',
                    ),
                    'utf8',
                ),
            ).toBe('');
            expect(loggedEvents()).toEqual([
                logEventCatalog.remoteSsh.masterReady,
                logEventCatalog.remoteSsh.probed,
                logEventCatalog.remoteSsh.installed,
                logEventCatalog.remoteSsh.launched,
                logEventCatalog.remoteSsh.forwarded,
            ]);
            expect(JSON.stringify(logger.write.mock.calls)).not.toContain(home);
        });

        it('adopts the running Server and reuses the master and forward on the next ensure', async () => {
            const supervisor = createSupervisor();
            await supervisor.ensure();
            const first = await supervisor.discoverDesktop();
            const execsBefore = transports[0]?.execs.length ?? 0;
            states = [];
            await supervisor.ensure();
            expect(transports).toHaveLength(1);
            // Only the launch script runs: the probe is cached and the build is installed.
            expect(transports[0]?.execs.length).toBe(execsBefore + 1);
            expect(transports[0]?.forwards).toEqual([REMOTE_PORT]);
            expect((await supervisor.discoverDesktop()).manifest).toEqual(first.manifest);
            // A later attach (the reconnect loop after a dropped WebSocket) reports itself as reconnecting.
            expect(phases()).toEqual(['reconnecting', 'probing', 'starting', 'connected']);
        });

        it('reports a lost master and reconnects with a new one', async () => {
            const supervisor = createSupervisor();
            await supervisor.ensure();
            transports[0]?.drop();
            expect(states.at(-1)).toMatchObject({
                failure: { reason: 'connectionLost' },
                phase: 'reconnecting',
            });
            await expect(supervisor.discoverDesktop()).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(supervisor.isFailed()).toBe(false);
            await supervisor.ensure();
            expect(transports).toHaveLength(2);
            expect(transports[1]?.forwards).toEqual([REMOTE_PORT]);
            expect(states.at(-1)?.phase).toBe('connected');
        });

        it('stops retrying after an authentication failure until reconnect', async () => {
            startFailure = new SshConnectionError(
                'authentication',
                'dev@lab: Permission denied (publickey).',
            );
            const supervisor = createSupervisor();
            const error = await captureRejection(supervisor.ensure());
            expect(error).toBeInstanceOf(RemoteSetupError);
            expect(error).toMatchObject({ code: 'UNAVAILABLE', reason: 'authentication' });
            expect(supervisor.isFailed()).toBe(true);
            expect(states.at(-1)).toEqual({
                failure: {
                    message: 'dev@lab: Permission denied (publickey).',
                    reason: 'authentication',
                },
                needsUserAction: true,
                phase: 'failed',
                progress: undefined,
            });

            await expect(supervisor.ensure()).rejects.toBe(error);
            expect(transports).toHaveLength(1);

            startFailure = undefined;
            supervisor.reconnect();
            expect(supervisor.isFailed()).toBe(false);
            await supervisor.ensure();
            expect(states.at(-1)?.phase).toBe('connected');
        });

        it('keeps retrying an unreachable host', async () => {
            startFailure = new SshConnectionError(
                'unreachable',
                'ssh: connect to host lab port 22: Connection refused',
            );
            const supervisor = createSupervisor();
            await expect(supervisor.ensure()).rejects.toMatchObject({ reason: 'unreachable' });
            expect(supervisor.isFailed()).toBe(false);
            expect(states.at(-1)).toMatchObject({ needsUserAction: false, phase: 'failed' });
        });

        it.each([
            [{ glibc: '2.17' }, 'unsupportedGlibc', /glibc 2\.17/u],
            [{ os: 'Darwin' }, 'unsupportedPlatform', /Darwin/u],
            [{ arch: 'riscv64' }, 'unsupportedPlatform', /riscv64/u],
        ])('refuses an unsupported host %j', async (shimOptions, reason, message) => {
            await writeShims(shims, linuxShims(shimOptions));
            const supervisor = createSupervisor();
            const ensured = supervisor.ensure();
            await expect(ensured).rejects.toMatchObject({ reason });
            await expect(ensured).rejects.toThrow(message);
            expect(supervisor.isFailed()).toBe(true);
            expect(states.at(-1)).toMatchObject({ needsUserAction: false, phase: 'failed' });
            expect(transports[0]?.execs).toHaveLength(1);
        });

        it('fails clearly when the build has no layer for the host architecture', async () => {
            await writeShims(shims, linuxShims({ arch: 'aarch64' }));
            const supervisor = createSupervisor();
            await expect(supervisor.ensure()).rejects.toMatchObject({ reason: 'installFailed' });
        });

        it('seeds Desktop config into a fresh remote profile only', async () => {
            const seedConfig = vi.fn(() =>
                Promise.resolve({ settings: '{"theme":"dark"}', theme: '{"name":"x"}' }),
            );
            const supervisor = createSupervisor({ seedConfig });
            await supervisor.ensure();
            const config = join(home, '.caxri-server/profile/config');
            expect(await readFile(join(config, 'settings.jsonc'), 'utf8')).toBe('{"theme":"dark"}');
            expect(await readFile(join(config, 'theme.json'), 'utf8')).toBe('{"name":"x"}');

            transports[0]?.drop();
            await writeFile(join(config, 'settings.jsonc'), 'remote edit');
            await supervisor.ensure();
            expect(seedConfig).toHaveBeenCalledTimes(1);
            expect(await readFile(join(config, 'settings.jsonc'), 'utf8')).toBe('remote edit');
        });

        it('relaunches after the operator handshake fails and waits for an exited Server', async () => {
            const supervisor = createSupervisor();
            await supervisor.ensure();
            const { manifest } = await supervisor.discoverDesktop();

            operatorFailure = new Error('handshake failed');
            await expect(supervisor.ensure()).rejects.toThrow('handshake failed');
            await expect(supervisor.discoverDesktop()).rejects.toMatchObject({ code: 'NOT_FOUND' });
            operatorFailure = undefined;
            await supervisor.ensure();

            process.kill(manifest.pid, 'SIGKILL');
            const startedAt = Date.now();
            await supervisor.waitForExit(manifest.pid, 5000);
            expect(Date.now() - startedAt).toBeLessThan(4000);
            await expect(supervisor.discoverDesktop()).rejects.toMatchObject({ code: 'NOT_FOUND' });

            await supervisor.ensure();
            const relaunched = await supervisor.discoverDesktop();
            expect(relaunched.manifest.pid).not.toBe(manifest.pid);
        });

        it('closes the master on dispose and refuses further attaches', async () => {
            const supervisor = createSupervisor();
            await supervisor.ensure();
            await supervisor.dispose();
            expect(transports[0]?.isOpen).toBe(false);
            expect(states.at(-1)?.phase).toBe('disconnected');
            await expect(supervisor.ensure()).rejects.toMatchObject({ code: 'CANCELLED' });
            // Closing a window only detaches: the remote Server keeps running.
            const manifest = JSON.parse(
                await readFile(join(home, '.caxri-server/profile/host/manifest.json'), 'utf8'),
            ) as { pid: number };
            expect(() => process.kill(manifest.pid, 0)).not.toThrow();
        });

        it('closes an askpass bridge that finishes creating after dispose', async () => {
            const close = vi.fn(() => Promise.resolve());
            let finishCreate: (() => void) | undefined;
            const supervisor = createSupervisor({
                createAskpass: () =>
                    new Promise((resolve) => {
                        finishCreate = () =>
                            resolve({ beginAttempt: () => {}, close, environment: () => ({}) });
                    }),
            });
            const ensured = captureRejection(supervisor.ensure());
            await vi.waitFor(() => expect(finishCreate).toBeDefined());
            await supervisor.dispose();
            finishCreate?.();
            await expect(ensured).resolves.toMatchObject({
                message: 'SSH Host connection was closed',
            });
            expect(close).toHaveBeenCalledOnce();
        });

        it('shares one setup between concurrent ensure calls', async () => {
            const supervisor = createSupervisor();
            await Promise.all([supervisor.ensure(), supervisor.ensure()]);
            expect(transports).toHaveLength(1);
            expect(
                transports[0]?.execs.filter((script) => script.includes('caxri_emit')),
            ).toHaveLength(1);
        });

        it('rejects an invalid destination up front', () => {
            expect(() => createSupervisor({ destination: '-oProxyCommand=id' })).toThrow();
        });
    });
});

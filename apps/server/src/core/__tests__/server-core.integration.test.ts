import { Buffer } from 'node:buffer';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { connectToServer, ServerClient } from '@caxri/client/supervise';
import type { ServerManifest } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    localServerEventSchema,
    localServerWelcomeSchema,
    serverEndpointUrl,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { createTestProtocolRecoveryState } from '../../__tests__/support/protocol-recovery';
import { removeTestDirectory } from '../../__tests__/support/remove-test-directory';
import type { CreateDomainServices } from '../../core/domain-service';
import type { DomainHandlers } from '../../domains/domain-services';
import * as extensionServiceFactory from '../extensions/create-service';
import type { ServerCore } from '../server-core';
import { startServerCore } from '../server-core';
import { createMemoryCredentialStores } from './credential-stores.fixture';

function fixtureHandlers(overrides: Partial<DomainHandlers>): DomainHandlers {
    return overrides as DomainHandlers;
}

function createDomainFixture(activePtyCount: number): CreateDomainServices {
    return (dependencies) =>
        Promise.resolve({
            close: async () => dependencies.agentEndpoints?.close(),
            handlers: fixtureHandlers({
                'app.health': () => ({
                    ready: true,
                    pid: process.pid,
                    startedAt: Date.now(),
                    activePtyCount,
                }),
                'project.queryForPrincipal': ({ principal }) => ({
                    view: principal.kind,
                    projects: [
                        {
                            id: 'project-1',
                            title: 'Caxri',
                            rootPath: '$HOME/code/caxri',
                        },
                    ],
                }),
            }),
            credentials: createMemoryCredentialStores(),
            protocolRecovery: createTestProtocolRecoveryState(),
            validateRequestContext: () => {},
        });
}

function createMutationRaceFixture(): CreateDomainServices {
    return (dependencies) => {
        let activePtyCount = 0;
        return Promise.resolve({
            close: async () => dependencies.agentEndpoints?.close(),
            handlers: fixtureHandlers({
                'app.health': () => ({
                    ready: true,
                    pid: process.pid,
                    startedAt: Date.now(),
                    activePtyCount,
                }),
                'terminal.sendInternal': async ({ enter, terminalId, text }) => {
                    dependencies.send({
                        event: 'state.changed',
                        payload: { kind: 'full', reason: 'session.select' },
                    });
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    activePtyCount = 1;
                    return {
                        terminalId,
                        accepted: true,
                        byteLength: Buffer.byteLength(text, 'utf8'),
                        enter,
                    };
                },
            }),
            credentials: createMemoryCredentialStores(),
            protocolRecovery: createTestProtocolRecoveryState(),
            validateRequestContext: () => {},
        });
    };
}

const apps: ServerCore[] = [];
const directories: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
    const socketsToClose = sockets.slice();
    sockets.length = 0;
    for (const socket of socketsToClose) socket.terminate();

    const appsToStop = apps.slice();
    apps.length = 0;
    await Promise.all(appsToStop.map((app) => app.stop('test-cleanup')));

    const directoriesToRemove = directories.slice();
    directories.length = 0;
    await Promise.all(directoriesToRemove.map((directory) => removeTestDirectory(directory)));
});

function messageReader(socket: WebSocket): () => Promise<unknown> {
    const values: unknown[] = [];
    const readers: Array<(value: unknown) => void> = [];
    socket.on('message', (data) => {
        if (!Buffer.isBuffer(data)) throw new TypeError('Expected one buffered text message');
        const value = JSON.parse(data.toString()) as unknown;
        const reader = readers.shift();
        if (reader) reader(value);
        else values.push(value);
    });
    return () => {
        const value = values.shift();
        if (value !== undefined) return Promise.resolve(value);
        return new Promise<unknown>((resolve) => {
            readers.push(resolve);
        });
    };
}

async function connectDesktop(manifest: ServerManifest, desktopToken: string) {
    const socket = new WebSocket(serverEndpointUrl(manifest.endpoint));
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    const read = messageReader(socket);
    socket.send(
        `${JSON.stringify({
            type: 'hello',
            clientId: 'desktop-test',
            supportedVersions: [CAXRI_PROTOCOL_VERSION],
            profileId: manifest.profileId,
            credential: { kind: 'desktop', token: desktopToken, desktopId: 'desktop-test' },
        })}\n`,
    );
    const welcome = localServerWelcomeSchema.parse(await read());
    if (!welcome.desktopLease) throw new Error('Desktop fixture did not receive a lease');
    socket.send(
        `${JSON.stringify({
            type: 'desktop.ready',
            generation: welcome.desktopLease.generation,
        })}\n`,
    );
    return { read, socket };
}

async function waitForRemoval(path: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            // Each attempt must observe the outcome of the previous poll before deciding
            // whether to retry, so the polling cannot be parallelized.
            // eslint-disable-next-line no-await-in-loop -- sequential polling by design
            await access(path);
        } catch {
            return;
        }
        // eslint-disable-next-line no-await-in-loop -- sequential retry backoff by design
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for Host metadata removal: ${path}`);
}

describe('Server Core application', () => {
    it('serves domain operations inside the Server Core process', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-server-core-'));
        directories.push(userDataPath);
        const app = await startServerCore({
            commit: 'test',
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);
        const operator = await connectToServer(userDataPath, 2_000);

        await expect(operator.request('app.health')).resolves.toMatchObject({
            activePtyCount: 0,
            pid: process.pid,
            ready: true,
        });
        await expect(operator.request('host.status')).resolves.toMatchObject({ pid: process.pid });
        await expect(operator.request('events.query', { afterCursor: 0 })).resolves.toMatchObject({
            kind: 'events',
            events: [expect.objectContaining({ event: 'runtime.status' })],
        });

        operator.close();
    });

    it('catches up through the persisted changefeed after a Server restart', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-server-changefeed-'));
        directories.push(userDataPath);
        const firstApp = await startServerCore({
            commit: 'test',
            userDataPath,
            version: '1.0.0',
        });
        apps.push(firstApp);
        const firstClient = await connectToServer(userDataPath, 2_000);
        const firstIdentity = firstClient.welcome.connection!;
        expect(firstApp.protocolIdentity).toEqual({
            serverId: firstIdentity.serverId,
            stateEpoch: firstIdentity.stateEpoch,
        });
        const firstRecovery = await firstClient.request('events.query', {
            afterCursor: 0,
            serverId: firstIdentity.serverId,
            stateEpoch: firstIdentity.stateEpoch,
        });
        firstClient.close();
        await firstApp.stop('test-restart');

        const secondApp = await startServerCore({
            commit: 'test',
            userDataPath,
            version: '1.0.0',
        });
        apps.push(secondApp);
        const secondClient = await connectToServer(userDataPath, 2_000);
        const secondIdentity = secondClient.welcome.connection!;

        expect(secondIdentity.serverId).toBe(firstIdentity.serverId);
        expect(secondIdentity.stateEpoch).toBe(firstIdentity.stateEpoch);
        expect(secondIdentity.bootId).not.toBe(firstIdentity.bootId);
        const recovered = await secondClient.request('events.query', {
            afterCursor: firstRecovery.cursor,
            serverId: firstIdentity.serverId,
            stateEpoch: firstIdentity.stateEpoch,
        });
        expect(recovered).toMatchObject({
            kind: 'events',
            events: [expect.objectContaining({ event: 'runtime.status' })],
        });
        expect(JSON.stringify(recovered)).not.toContain(firstIdentity.serverId);
        expect(JSON.stringify(recovered)).not.toContain(firstIdentity.stateEpoch);
        const mismatched = await secondClient.request('events.query', {
            afterCursor: firstRecovery.cursor,
            serverId: firstIdentity.serverId,
            stateEpoch: 'f'.repeat(32),
        });
        expect(mismatched).toMatchObject({ kind: 'snapshot', gap: true });
        expect(JSON.stringify(mismatched)).not.toContain(firstIdentity.serverId);
        expect(JSON.stringify(mismatched)).not.toContain('f'.repeat(32));

        secondClient.close();
    });

    it('outlives client detach and requires confirmation before stopping a live PTY', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-host-'));
        directories.push(userDataPath);
        const app = await startServerCore({
            commit: 'test',
            createDomainServices: createDomainFixture(1),
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);

        await expect(
            ServerClient.connect({ ...app.lease.manifest, protocolVersion: 1 }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });

        const first = await connectToServer(userDataPath, 2_000);
        const health = await first.request('app.health');
        expect(health).toMatchObject({ ready: true, activePtyCount: 1 });
        await expect(first.request('project.query', { mode: 'list' })).resolves.toEqual({
            view: 'human-cli',
            projects: [{ id: 'project-1', title: 'Caxri', rootPath: '$HOME/code/caxri' }],
        });
        first.close();

        const second = await connectToServer(userDataPath, 2_000);
        const status = await second.request('host.status');
        expect(status).toMatchObject({
            pid: process.pid,
            activePtyCount: 1,
            protocolCompatible: true,
        });
        expect(JSON.stringify(status)).not.toContain(app.lease.manifest.operatorToken);

        await expect(second.request('host.stop', { confirmLivePtys: false })).rejects.toMatchObject(
            { code: 'CONFLICT' },
        );
        await expect(access(app.lease.paths.manifest)).resolves.toBeUndefined();

        const confirmed = await second.request('host.stop', { confirmLivePtys: true });
        expect(confirmed).toMatchObject({ stopping: true, activePtyCount: 1 });
        await waitForRemoval(app.lease.paths.manifest);
        // The logger now drains writes asynchronously, so first poll for the sentinel
        // `server_core.stopped` record (emitted at the end of the `stop()` flow above) to prove the
        // log has been flushed to disk, then assert the token is absent.
        await vi.waitFor(async () => {
            const contents = await readFile(
                join(userDataPath, 'logs', 'server-core.jsonl'),
                'utf8',
            );
            expect(contents).toContain('server_core.stopped');
        });
        expect(
            await readFile(join(userDataPath, 'logs', 'server-core.jsonl'), 'utf8'),
        ).not.toContain(app.lease.manifest.operatorToken);
    });

    it('closes mutation admission before evaluating an unconfirmed stop', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-stop-race-'));
        directories.push(userDataPath);
        const app = await startServerCore({
            commit: 'test',
            createDomainServices: createMutationRaceFixture(),
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);
        const desktop = await connectDesktop(
            app.lease.manifest,
            app.lease.desktopCredential.desktopToken,
        );
        const operator = await connectToServer(userDataPath, 2_000);

        desktop.socket.send(
            `${JSON.stringify({
                type: 'command',
                request: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: 'mutation-1',
                    method: 'terminal.send',
                    params: { terminalId: 'terminal-1', text: 'x', enter: false },
                },
            })}\n`,
        );
        localServerEventSchema.parse(await desktop.read());
        await expect(
            operator.request('host.stop', { confirmLivePtys: false }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        await expect(access(app.lease.paths.manifest)).resolves.toBeUndefined();

        await operator.request('host.stop', { confirmLivePtys: true });
        await expect(app.stopping).resolves.toBeUndefined();
        await expect(app.stopped).resolves.toBeUndefined();
        await waitForRemoval(app.lease.paths.manifest);
        operator.close();
    });

    it('finishes an accepted stop after the requesting client disconnects', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-headless-stop-disconnect-'));
        directories.push(userDataPath);
        const app = await startServerCore({
            commit: 'test',
            createDomainServices: createDomainFixture(1),
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);
        const desktop = await connectDesktop(
            app.lease.manifest,
            app.lease.desktopCredential.desktopToken,
        );
        await new Promise<void>((resolve, reject) => {
            desktop.socket.send(
                `${JSON.stringify({
                    type: 'command',
                    request: {
                        protocolVersion: CAXRI_PROTOCOL_VERSION,
                        id: 'stop-disconnect',
                        method: 'host.stop',
                        params: { confirmLivePtys: true },
                    },
                })}\n`,
                (error) => {
                    if (error) reject(error);
                    else {
                        desktop.socket.terminate();
                        resolve();
                    }
                },
            );
        });

        await waitForRemoval(app.lease.paths.manifest);
    });

    it('suppresses only the expected extension refresh rejection during shutdown', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-extension-refresh-stop-'));
        directories.push(userDataPath);
        const stateChanged = {
            event: 'state.changed',
            payload: { kind: 'full', reason: 'session.select' },
        } as const;
        let emit: ((event: typeof stateChanged) => void) | undefined;
        const refreshError = new Error('Extension context refresh failed before shutdown');
        vi.spyOn(extensionServiceFactory, 'createExtensionService').mockResolvedValue({
            activeContextChanged: vi.fn(),
            markCoreStopping: vi.fn(),
            shutdown: vi.fn(),
        } as never);
        const app = await startServerCore({
            commit: 'test',
            createDomainServices: (dependencies) => {
                emit = dependencies.send;
                return Promise.resolve({
                    close: () => Promise.resolve(dependencies.send(stateChanged)),
                    handlers: fixtureHandlers({
                        'app.activeContext': () => {
                            throw refreshError;
                        },
                    }),
                    credentials: createMemoryCredentialStores(),
                    protocolRecovery: createTestProtocolRecoveryState(),
                    validateRequestContext: () => {},
                });
            },
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);

        emit?.(stateChanged);
        const logPath = join(userDataPath, 'logs', 'server-core.jsonl');
        await vi.waitFor(async () =>
            expect(await readFile(logPath, 'utf8')).toContain(refreshError.message),
        );
        const countFailures = async () =>
            (
                (await readFile(logPath, 'utf8')).match(
                    /extension_host\.context_refresh_failed/g,
                ) ?? []
            ).length;
        const refreshFailureCount = await countFailures();

        await app.stop('test-extension-refresh-shutdown');
        await vi.waitFor(async () =>
            expect(await readFile(logPath, 'utf8')).toContain('server_core.stopped'),
        );
        expect(await countFailures()).toBe(refreshFailureCount);
    });

    it('exits through the normal shutdown path once idle past the threshold with no connections and no live PTYs', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-idle-exit-'));
        directories.push(userDataPath);
        const app = await startServerCore({
            commit: 'test',
            createDomainServices: createDomainFixture(0),
            idleExitThresholdMs: 50,
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);

        await waitForRemoval(app.lease.paths.manifest);
        const logPath = join(userDataPath, 'logs', 'server-core.jsonl');
        await vi.waitFor(async () =>
            expect(await readFile(logPath, 'utf8')).toContain('server_core.stopped'),
        );
        const contents = await readFile(logPath, 'utf8');
        const triggered = contents
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { event: string; fields?: Record<string, unknown> })
            .find((record) => record.event === 'server_core.idle_exit_triggered');
        expect(triggered?.fields).toMatchObject({ deferralCount: 0, reason: 'idle-timeout' });
    });

    it('defers idle exit while a Terminal PTY is still active instead of destroying live work', async () => {
        const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-idle-exit-busy-'));
        directories.push(userDataPath);
        const app = await startServerCore({
            commit: 'test',
            createDomainServices: createDomainFixture(1),
            idleExitThresholdMs: 50,
            userDataPath,
            version: '1.0.0',
        });
        apps.push(app);

        const logPath = join(userDataPath, 'logs', 'server-core.jsonl');
        await vi.waitFor(async () =>
            expect(await readFile(logPath, 'utf8')).toContain('server_core.idle_exit_deferred'),
        );
        const deferred = (await readFile(logPath, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { event: string; fields?: Record<string, unknown> })
            .find((record) => record.event === 'server_core.idle_exit_deferred');
        expect(deferred?.fields).toMatchObject({ deferralCount: 1, reason: 'active-pty' });
        expect(await readFile(logPath, 'utf8')).not.toContain('server_core.idle_exit_triggered');
        await expect(access(app.lease.paths.manifest)).resolves.toBeUndefined();
    });
});

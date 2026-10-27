import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ServerClient } from '@caxri/client/supervise';
import type { CommandAdapter, ServerControlEndpoint } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    localServerReplySchema,
    localServerWelcomeSchema,
    protocolFeatures,
    serverEndpointUrl,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { ControlServer } from '../control-server';
import { acquireServerProfile } from '../profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    vi.restoreAllMocks();
    const cleanupsToRun = cleanups.slice();
    cleanups.length = 0;
    await Promise.all(cleanupsToRun.map((cleanup) => cleanup()));
});

async function profile() {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-host-regression-'));
    const lease = await acquireServerProfile({ userDataPath, version: '1.0.0' });
    cleanups.push(async () => {
        await lease.release();
        await rm(userDataPath, { recursive: true, force: true });
    });
    return lease;
}

async function connect(endpoint: ServerControlEndpoint): Promise<WebSocket> {
    const socket = new WebSocket(serverEndpointUrl(endpoint));
    await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });
    cleanups.push(() => {
        socket.terminate();
        return Promise.resolve();
    });
    return socket;
}

function messageReader(socket: WebSocket) {
    const values: unknown[] = [];
    const pending: Array<{ reject(error: Error): void; resolve(value: unknown): void }> = [];
    socket.on('message', (data) => {
        if (!Buffer.isBuffer(data)) throw new TypeError('Expected one buffered text message');
        const value = JSON.parse(data.toString()) as unknown;
        const waiter = pending.shift();
        if (waiter) waiter.resolve(value);
        else values.push(value);
    });
    socket.on('close', () => {
        const pendingToReject = pending.slice();
        pending.length = 0;
        for (const waiter of pendingToReject) waiter.reject(new Error('Socket closed'));
    });
    return () =>
        values.length > 0
            ? Promise.resolve(values.shift())
            : new Promise<unknown>((resolve, reject) => {
                  pending.push({ resolve, reject });
              });
}

function command(id: string, method: string, parameters: unknown) {
    return JSON.stringify({
        type: 'command',
        request: { protocolVersion: CAXRI_PROTOCOL_VERSION, id, method, params: parameters },
    });
}

describe('local Host transport regressions', () => {
    it.each(['viewContainers.cancelRequest', 'requests.cancel'] as const)(
        'admits %s outside the ordered lane while a request is pending',
        async (cancelMethod) => {
            const lease = await profile();
            const operationStarted = Promise.withResolvers<void>();
            const operationRelease = Promise.withResolvers<void>();
            const cancelStarted = Promise.withResolvers<void>();
            const host: CommandAdapter = {
                invoke: async (request) => {
                    if (request.method === 'viewContainers.viewOperation') {
                        operationStarted.resolve();
                        await operationRelease.promise;
                        return {
                            revision: '1',
                            title: 'Source Control',
                            accessibilityLabel: 'Source Control providers',
                            modeAccessibilityLabel: 'Source Control mode',
                            modes: [],
                            selectedModeId: 'default',
                            refreshAction: {
                                id: 'refresh',
                                label: 'Refresh',
                                icon: { kind: 'theme', id: 'refresh' },
                                command: { id: 'publisher.refresh' },
                            },
                            providers: [],
                            emptyMessage: 'No providers.',
                        };
                    }
                    if (request.method === cancelMethod) {
                        cancelStarted.resolve();
                        return { cancelled: true };
                    }
                    return null;
                },
            };
            const server = new ControlServer({
                adapters: { server: host },
                desktopCredential: lease.desktopCredential,
                identity: lease.identity,
            });
            await lease.publish(await server.start());
            cleanups.push(() => server.close());

            const socket = await connect(lease.manifest.endpoint);
            const read = messageReader(socket);
            socket.send(
                `${JSON.stringify({
                    type: 'hello',
                    clientId: 'desktop-test',
                    supportedVersions: [CAXRI_PROTOCOL_VERSION],
                    profileId: lease.manifest.profileId,
                    credential: {
                        kind: 'desktop',
                        token: lease.desktopCredential.desktopToken,
                        desktopId: 'desktop-cancel',
                    },
                })}\n`,
            );
            localServerWelcomeSchema.parse(await read());
            socket.send(
                command('view-slow', 'viewContainers.viewOperation', {
                    viewId: 'publisher.git.sourceControl',
                    requestId: 'view-request',
                    operation: 'source.snapshot',
                    arguments: { refresh: 0 },
                    context: {
                        kind: 'session',
                        sessionId: 'session-1',
                        workbenchRootProjectId: 'project-1',
                    },
                }),
            );
            socket.send(command('view-cancel', cancelMethod, { requestId: 'view-request' }));
            await operationStarted.promise;
            await cancelStarted.promise;
            await expect(read()).resolves.toMatchObject({ reply: { id: 'view-cancel', ok: true } });
            operationRelease.resolve();
            await expect(read()).resolves.toMatchObject({ reply: { id: 'view-slow', ok: true } });
        },
    );

    it('dispatches a later business request before an earlier reply settles', async () => {
        const lease = await profile();
        const slowRequest = Promise.withResolvers<void>();
        const slowStarted = Promise.withResolvers<void>();
        const independentStarted = Promise.withResolvers<void>();
        let healthRequests = 0;
        const host: CommandAdapter = {
            invoke: async (request) => {
                if (request.method !== 'app.health') return null;
                healthRequests += 1;
                if (healthRequests === 1) {
                    slowStarted.resolve();
                    await slowRequest.promise;
                } else independentStarted.resolve();
                return { ready: true, pid: 88, startedAt: 1, activePtyCount: 0 };
            },
        };
        const server = new ControlServer({
            adapters: { server: host },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());

        const socket = await connect(lease.manifest.endpoint);
        const read = messageReader(socket);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'client-test',
                supportedVersions: [CAXRI_PROTOCOL_VERSION],
                profileId: lease.manifest.profileId,
                credential: { kind: 'operator', token: lease.manifest.operatorToken },
            })}\n`,
        );
        localServerWelcomeSchema.parse(await read());
        socket.send(command('health-slow', 'app.health', {}));
        socket.send(command('health-independent', 'app.health', {}));
        await slowStarted.promise;
        await independentStarted.promise;

        const independentReply = await read();
        slowRequest.resolve();
        const slowReply = await read();

        expect(independentReply).toMatchObject({ reply: { id: 'health-independent', ok: true } });
        expect(slowReply).toMatchObject({ reply: { id: 'health-slow', ok: true } });
    });

    it('admits later requests while an authoritative file write remains pending', async () => {
        const lease = await profile();
        const writeRelease = Promise.withResolvers<void>();
        const writeStarted = Promise.withResolvers<void>();
        const secondWriteStarted = Promise.withResolvers<void>();
        const healthStarted = Promise.withResolvers<void>();
        const writeOrder: string[] = [];
        const host: CommandAdapter = {
            invoke: async (request) => {
                if (request.method === 'files.write') {
                    writeOrder.push(request.params.path);
                    if (request.params.path === '/project/a.txt') {
                        writeStarted.resolve();
                        await writeRelease.promise;
                    } else secondWriteStarted.resolve();
                    return {
                        path: request.params.path,
                        content: request.params.content,
                        mtimeMs: 1,
                        size: request.params.content.length,
                    };
                }
                if (request.method === 'app.health') {
                    healthStarted.resolve();
                    return { ready: true, pid: 88, startedAt: 1, activePtyCount: 0 };
                }
                return null;
            },
        };
        const server = new ControlServer({
            adapters: { features: protocolFeatures, server: host },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: 'a'.repeat(32),
                stateEpoch: 'b'.repeat(32),
            },
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const client = await ServerClient.connect(lease.manifest, 5_000, {
            kind: 'desktop',
            desktopId: 'desktop-file-write',
            credential: lease.desktopCredential,
            handleCommand: () => Promise.resolve(null),
        });
        cleanups.push(() => {
            client.close();
            return Promise.resolve();
        });

        const write = client.request('files.write', {
            sessionId: 'session-1',
            path: '/project/a.txt',
            content: 'saved',
        });
        await writeStarted.promise;
        const secondWrite = client.request('files.write', {
            sessionId: 'session-1',
            path: '/project/b.txt',
            content: 'independent',
        });
        await secondWriteStarted.promise;
        const health = client.request('app.health', {});
        await healthStarted.promise;

        expect(writeOrder).toEqual(['/project/a.txt', '/project/b.txt']);
        await expect(secondWrite).resolves.toMatchObject({ content: 'independent' });
        await expect(health).resolves.toMatchObject({ ready: true });
        writeRelease.resolve();
        await expect(write).resolves.toMatchObject({ content: 'saved' });
    });

    it('keeps unrelated Terminal control responsive while a long paste is being saved', async () => {
        const lease = await profile();
        const saveRelease = Promise.withResolvers<void>();
        const saveStarted = Promise.withResolvers<void>();
        const healthStarted = Promise.withResolvers<void>();
        const host: CommandAdapter = {
            invoke: async (request) => {
                if (request.method === 'terminal.prepareLongPaste') {
                    saveStarted.resolve();
                    await saveRelease.promise;
                    return {
                        agentLaunchId: 'launch-1',
                        characterCount: 1_025,
                        filePath: '/tmp/paste.txt',
                        lineCount: 1,
                        status: 'saved',
                    };
                }
                if (request.method === 'app.health') {
                    healthStarted.resolve();
                    return { ready: true, pid: 88, startedAt: 1, activePtyCount: 0 };
                }
                return null;
            },
        };
        const server = new ControlServer({
            adapters: { server: host },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const client = await ServerClient.connect(lease.manifest, 5_000, {
            kind: 'desktop',
            desktopId: 'desktop-long-paste',
            credential: lease.desktopCredential,
            handleCommand: () => Promise.resolve(null),
        });
        cleanups.push(() => {
            client.close();
            return Promise.resolve();
        });

        const saving = client.request('terminal.prepareLongPaste', {
            terminalId: 'terminal-1',
            content: 'x'.repeat(1_025),
        });
        await saveStarted.promise;
        const health = client.request('app.health', {});
        await healthStarted.promise;
        await expect(health).resolves.toMatchObject({ ready: true });
        saveRelease.resolve();
        await expect(saving).resolves.toEqual({
            agentLaunchId: 'launch-1',
            characterCount: 1_025,
            filePath: '/tmp/paste.txt',
            lineCount: 1,
            status: 'saved',
        });
    });

    it('preserves mutation order while reads settle concurrently', async () => {
        const lease = await profile();
        const firstMutation = Promise.withResolvers<void>();
        const firstStarted = Promise.withResolvers<void>();
        const invocationOrder: number[] = [];
        vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new Uint8Array(32).buffer);
        const host: CommandAdapter = {
            invoke: async (request) => {
                if (request.method !== 'settings.patch') return null;
                const fontSize = request.params.changes[0]?.value as number;
                invocationOrder.push(fontSize);
                if (invocationOrder.length === 1) {
                    firstStarted.resolve();
                    await firstMutation.promise;
                }
                return {
                    value: {
                        'session.defaultAgent': null,
                        'workbench.newWorktreeBehavior': 'ask',
                        'terminal.fontSize': fontSize,
                        'terminal.scrollback': 2_000,
                        'terminal.copyOnSelect': true,
                        'terminal.gpuAcceleration': 'off',
                        'terminal.osc52ClipboardWrite': false,
                        'files.maxFileBytes': 2_097_152,
                    },
                    revision: 'a'.repeat(64),
                    errors: [],
                    dryRun: false,
                    changedKeys: ['terminal.fontSize'],
                };
            },
        };
        const server = new ControlServer({
            adapters: { server: host },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());
        const client = await ServerClient.connect(lease.manifest);
        cleanups.push(() => {
            client.close();
            return Promise.resolve();
        });

        const first = client.requestWithId('settings-first', 'settings.patch', {
            changes: [{ key: 'terminal.fontSize', value: 17 }],
            dryRun: false,
        });
        await firstStarted.promise;
        const second = client.requestWithId('settings-second', 'settings.patch', {
            changes: [{ key: 'terminal.fontSize', value: 18 }],
            dryRun: false,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(invocationOrder).toEqual([17]);

        firstMutation.resolve();
        await Promise.all([first, second]);
        expect(invocationOrder).toEqual([17, 18]);
    });

    it('round-trips configured file payloads larger than the former transport limit', async () => {
        const lease = await profile();
        const largeWrite = 'w'.repeat(1_100_000);
        const largeRead = 'r'.repeat(2_100_000);
        const host: CommandAdapter = {
            invoke: (request) => ({
                path: '/project/large.txt',
                content: request.method === 'files.read' ? largeRead : largeWrite,
                mtimeMs: 1,
                size: request.method === 'files.read' ? largeRead.length : largeWrite.length,
            }),
        };
        const server = new ControlServer({
            adapters: { features: protocolFeatures, server: host },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
            protocolIdentity: {
                serverId: 'a'.repeat(32),
                stateEpoch: 'b'.repeat(32),
            },
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());

        const client = await ServerClient.connect(lease.manifest, 5_000, {
            kind: 'desktop',
            desktopId: 'desktop-regression',
            credential: lease.desktopCredential,
            handleCommand: () => Promise.resolve(null),
        });
        cleanups.push(() => {
            client.close();
            return Promise.resolve();
        });

        await expect(
            client.request('files.write', {
                sessionId: 'session-1',
                path: '/project/large.txt',
                content: largeWrite,
            }),
        ).resolves.toMatchObject({ content: largeWrite });
        await expect(
            client.request('files.read', { sessionId: 'session-1', path: '/project/large.txt' }),
        ).resolves.toMatchObject({ content: largeRead });
    });

    it('severs the replaced Desktop socket without accumulating connection state', async () => {
        const lease = await profile();
        const server = new ControlServer({
            adapters: { server: { invoke: () => null } },
            desktopCredential: lease.desktopCredential,
            identity: lease.identity,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());

        const socket = await connect(lease.manifest.endpoint);
        const read = messageReader(socket);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'desktop-test',
                supportedVersions: [CAXRI_PROTOCOL_VERSION],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'desktop',
                    token: lease.desktopCredential.desktopToken,
                    desktopId: 'desktop-replaced',
                },
            })}\n`,
        );
        const welcome = localServerWelcomeSchema.parse(await read());
        const generation = welcome.desktopLease!.generation;
        socket.send(JSON.stringify({ type: 'desktop.ready', generation }));
        await vi.waitFor(() => expect(server.desktopLease()?.generation).toBe(generation));
        const closed = new Promise<void>((resolve) => socket.once('close', resolve));
        // A reverse command the replaced Desktop never answers must settle with a stable error
        // before its socket is destroyed, not hang until the command timeout.
        const pending = expect(
            server.invokeDesktop({ kind: 'focus' }, generation),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });

        const replacement = await ServerClient.connect(lease.manifest, 2_000, {
            kind: 'desktop',
            desktopId: 'desktop-replacement',
            credential: lease.desktopCredential,
            handleCommand: () => Promise.resolve(null),
        });
        cleanups.push(() => {
            replacement.close();
            return Promise.resolve();
        });
        await pending;
        await closed;
        expect(server.clientCount()).toBe(1);
        const sockets = Reflect.get(server, 'sockets') as Set<unknown>;
        await vi.waitFor(() => expect(sockets.size).toBe(1));
        // The replacement keeps full Desktop capability after the takeover.
        await replacement.markDesktopReady();
        await vi.waitFor(() =>
            expect(server.desktopLease()?.generation).toBe(replacement.desktopLease!.generation),
        );
    });

    it('logs independent request outcomes without inherited queue wait', async () => {
        const lease = await profile();
        const slowRelease = Promise.withResolvers<void>();
        const slowStarted = Promise.withResolvers<void>();
        let healthCalls = 0;
        const host: CommandAdapter = {
            invoke: async (request) => {
                if (request.method !== 'app.health') return null;
                healthCalls += 1;
                if (healthCalls === 1) {
                    slowStarted.resolve();
                    await slowRelease.promise;
                } else if (healthCalls === 3)
                    throw new CaxriError('UNAVAILABLE', 'health probe is down');
                return { ready: true, pid: 88, startedAt: 1, activePtyCount: 0 };
            },
        };
        const written: Array<{
            level: string;
            event: string;
            options?: {
                correlationId?: string;
                durationMs?: number;
                fields?: Record<string, string | number | boolean | null>;
            };
        }> = [];
        const server = new ControlServer({
            adapters: { server: host },
            desktopCredential: lease.desktopCredential,
            logger: { write: (level, event, options) => written.push({ level, event, options }) },
            identity: lease.identity,
            requestQueueWarnMs: 10_000,
            requestTotalWarnMs: 10_000,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());

        const socket = await connect(lease.manifest.endpoint);
        const read = messageReader(socket);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'client-test',
                supportedVersions: [2],
                profileId: lease.manifest.profileId,
                credential: { kind: 'operator', token: lease.manifest.operatorToken },
            })}\n`,
        );
        localServerWelcomeSchema.parse(await read());
        // Three back-to-back messages: the slow first request must not make either later request inherit its execution
        // time as queue wait.
        socket.send(command('health-slow', 'app.health', {}));
        socket.send(command('health-queued', 'app.health', {}));
        socket.send(command('health-failed', 'app.health', {}));
        await slowStarted.promise;
        const independentReplies = [
            localServerReplySchema.parse(await read()),
            localServerReplySchema.parse(await read()),
        ];
        expect(
            independentReplies
                .map((message) => message.reply.id)
                .filter((id): id is string => id !== null)
                .toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(['health-failed', 'health-queued']);
        expect(written.some((entry) => entry.options?.correlationId === 'health-slow')).toBe(false);
        slowRelease.resolve();
        await expect(read()).resolves.toMatchObject({ reply: { id: 'health-slow' } });

        const slow = written.find((entry) => entry.options?.correlationId === 'health-slow');
        expect(slow).toMatchObject({ level: 'debug', event: 'ipc.request' });
        expect(slow?.options?.fields).toMatchObject({
            method: 'app.health',
            principal: 'human-cli',
            queueDepth: 1,
        });

        const queued = written.find((entry) => entry.options?.correlationId === 'health-queued');
        expect(queued).toMatchObject({ level: 'debug', event: 'ipc.request' });
        /**
         * WebSocket message delivery can interleave with the microtask that releases a concurrent read's ordered
         * admission entry. The second request therefore observes either itself alone or itself plus the first entry;
         * the stable contract is that its execution and queue wait do not inherit the blocked read's duration.
         */
        expect([1, 2]).toContain(queued?.options?.fields?.queueDepth);
        expect(slow?.options?.durationMs).toBeGreaterThan(
            queued?.options?.fields?.queueMs as number,
        );

        const failed = written.find((entry) => entry.options?.correlationId === 'health-failed');
        expect(failed).toMatchObject({ level: 'warn', event: 'ipc.request_failed' });
        expect(failed?.options?.fields).toMatchObject({ code: 'UNAVAILABLE' });
    });
});

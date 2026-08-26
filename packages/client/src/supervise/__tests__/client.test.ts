import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type * as fsPromises from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof fsPromises>()),
    readFile: readFileMock,
}));

import { discoverServerManifest, ensureServer, ServerClient } from '../client';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    readFileMock.mockReset();
    const pending = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ServerClient close notification', () => {
    /**
     * The constructor is TypeScript-private (real attachments go through `ServerClient.connect`), so this narrow
     * lifecycle test instantiates it directly with a socket stand-in.
     */
    function createAttachedClient(options: { desktopLease?: unknown } = {}) {
        const listeners = new Map<string, Array<(...arguments_: unknown[]) => void>>();
        const socket = {
            bufferedAmount: 0,
            close: vi.fn(() => socket.emit('close')),
            emit(name: string, ...arguments_: unknown[]): void {
                const registered = listeners.get(name) ?? [];
                for (const listener of registered) listener(...arguments_);
            },
            on(name: string, listener: (...arguments_: unknown[]) => void) {
                listeners.set(name, [...(listeners.get(name) ?? []), listener]);
                return socket;
            },
            readyState: 1,
            send: vi.fn((_source: string, callback?: (error?: Error) => void) => callback?.()),
            terminate: vi.fn(() => socket.emit('close')),
        };
        const construct = ServerClient as unknown as new (
            socket: unknown,
            welcome: unknown,
            timeoutMs: number,
            desktopLease?: unknown,
        ) => ServerClient;
        return {
            client: new construct(socket, { protocolVersion: 1 }, 1000, options.desktopLease),
            socket,
        };
    }

    it('notifies onClose listeners exactly once when the socket closes', () => {
        const { client, socket } = createAttachedClient();
        const listener = vi.fn();
        client.onClose(listener);

        socket.emit('close');
        socket.emit('close');
        socket.emit('error', new Error('late failure'));

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires a listener registered after closure synchronously', () => {
        const { client, socket } = createAttachedClient();
        socket.emit('close');
        const listener = vi.fn();

        client.onClose(listener);

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('stops notifying an unsubscribed listener', () => {
        const { client, socket } = createAttachedClient();
        const listener = vi.fn();
        const unsubscribe = client.onClose(listener);
        unsubscribe();

        socket.emit('close');

        expect(listener).not.toHaveBeenCalled();
    });

    it('notifies onClose on an explicit local close()', () => {
        const { client } = createAttachedClient();
        const listener = vi.fn();
        client.onClose(listener);

        client.close();

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('cancels pending requests when another Desktop replaces the lease', async () => {
        const { client, socket } = createAttachedClient({
            desktopLease: { desktopId: 'desktop-1', generation: 1, expiresAt: 1 },
        });
        const pending = client.request('app.health');

        socket.emit(
            'message',
            Buffer.from(
                JSON.stringify({
                    type: 'desktop-lease.revoked',
                    generation: 1,
                    reason: 'replaced',
                }),
            ),
            false,
        );

        await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    });

    it('cancels pending requests on explicit local disposal', async () => {
        const { client } = createAttachedClient();
        const pending = client.request('app.health');

        client.close({ cancelPendingRequests: true });

        await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    });
});

describe('ServerClient WebSocket handshake', () => {
    it('preserves a control message delivered immediately after welcome', async () => {
        const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
        await new Promise<void>((resolve, reject) => {
            server.once('listening', resolve);
            server.once('error', reject);
        });
        const address = server.address();
        if (!address || typeof address === 'string') throw new TypeError('Expected a TCP listener');
        const manifest = {
            endpoint: {
                protocol: 'ws' as const,
                host: '127.0.0.1' as const,
                port: address.port,
                path: '/control' as const,
            },
            manifestVersion: 2 as const,
            operatorToken: 'a'.repeat(64),
            pid: process.pid,
            processIdentity: 'b'.repeat(32),
            profileId: 'profile-1',
            protocolVersion: 2 as const,
            startedAt: 1,
            version: '1.0.0',
        };
        server.on('connection', (socket) => {
            socket.once('message', () => {
                socket.send(
                    JSON.stringify({
                        type: 'welcome',
                        profileId: manifest.profileId,
                        processIdentity: manifest.processIdentity,
                        protocolVersion: 2,
                        principal: { kind: 'desktop', id: 'desktop-1', generation: 1 },
                        capabilities: ['desktop'],
                        commands: [],
                        desktopLease: {
                            desktopId: 'desktop-1',
                            generation: 1,
                            expiresAt: Date.now() + 60_000,
                        },
                    }),
                );
                socket.send(
                    JSON.stringify({
                        type: 'desktop-lease.revoked',
                        generation: 1,
                        reason: 'replaced',
                    }),
                );
            });
        });

        let client: ServerClient | undefined;
        try {
            client = await ServerClient.connect(manifest, 2_000, {
                kind: 'desktop',
                desktopId: 'desktop-1',
                credential: {
                    credentialVersion: 1,
                    profileId: manifest.profileId,
                    processIdentity: manifest.processIdentity,
                    desktopToken: 'c'.repeat(64),
                },
                handleCommand: () => Promise.resolve(null),
            });
            const closed = vi.fn();
            client.onClose(closed);

            expect(closed).toHaveBeenCalledWith('replaced');
        } finally {
            client?.close();
            for (const socket of server.clients) socket.terminate();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});

describe('Server discovery', () => {
    it('classifies a manifest removed between metadata and content reads as absent', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-cli-host-discovery-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const hostDirectory = join(userDataPath, 'host');
        const manifestPath = join(hostDirectory, 'manifest.json');
        await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
        await chmod(hostDirectory, 0o700);
        await writeFile(manifestPath, '{}\n', { mode: 0o600 });
        const removed = Object.assign(new Error('manifest removed'), { code: 'ENOENT' });
        readFileMock.mockRejectedValueOnce(removed);

        await expect(discoverServerManifest(userDataPath)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('launches a replacement when an incompatible manifest belongs to a dead process', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-cli-stale-host-'));
        temporaryDirectories.push(directory);
        const userDataPath = join(directory, 'user-data');
        const hostDirectory = join(userDataPath, 'host');
        const manifestPath = join(hostDirectory, 'manifest.json');
        await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
        await chmod(hostDirectory, 0o700);
        await writeFile(manifestPath, '{}\n', { mode: 0o600 });
        const canonicalUserDataPath = await realpath(userDataPath);
        readFileMock.mockResolvedValue(
            JSON.stringify({
                endpoint: {
                    protocol: 'ws',
                    host: '127.0.0.1',
                    port: 41_337,
                    path: '/control',
                },
                manifestVersion: 2,
                operatorToken: 'a'.repeat(64),
                pid: process.pid,
                processIdentity: 'b'.repeat(32),
                profileId: createHash('sha256')
                    .update(canonicalUserDataPath)
                    .digest('hex')
                    .slice(0, 24),
                protocolVersion: 1,
                startedAt: 1,
                version: '1.0.0',
            }),
        );
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('dead process'), { code: 'ESRCH' });
        });

        await expect(
            ensureServer(userDataPath, { artifactRoot: join(directory, 'missing-server') }, 100),
        ).rejects.toMatchObject({
            code: 'UNAVAILABLE',
            message: 'Server artifact manifest is invalid',
        });
    });
});

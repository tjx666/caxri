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

import { ServerClient } from '../client';
import { discoverServerManifest } from '../discovery';
import { ensureServer } from '../server-supervisor';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    readFileMock.mockReset();
    const pending = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * The constructor is TypeScript-private (real attachments go through `ServerClient.connect`), so this narrow lifecycle
 * test instantiates it directly with a socket stand-in.
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

describe('ServerClient event fan-out', () => {
    it('delivers an event to later listeners when an earlier one throws, then closes the transport', () => {
        const { client, socket } = createAttachedClient();
        const failing = vi.fn(() => {
            throw new Error('listener failure');
        });
        const surviving = vi.fn();
        client.onEvent(failing);
        client.onEvent(surviving);
        const event = {
            event: 'terminal.output',
            payload: { terminalId: 'terminal-1', data: 'ok' },
        };

        socket.emit('message', Buffer.from(JSON.stringify({ type: 'event', event })), false);

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledExactlyOnceWith(event);
        expect(socket.terminate).toHaveBeenCalledTimes(1);
    });
});

describe('ServerClient close notification', () => {
    it('notifies onClose listeners exactly once when the socket closes', () => {
        const { client, socket } = createAttachedClient();
        const listener = vi.fn();
        client.onClose(listener);

        socket.emit('close');
        socket.emit('close');
        socket.emit('error', new Error('late failure'));

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies a later onClose listener when an earlier one throws', () => {
        const { client, socket } = createAttachedClient();
        const failing = vi.fn(() => {
            throw new Error('close listener failure');
        });
        const surviving = vi.fn();
        client.onClose(failing);
        client.onClose(surviving);

        socket.emit('close');

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
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

    it('reports the raw WebSocket close code alongside the revocation reason', () => {
        const { client, socket } = createAttachedClient();
        const listener = vi.fn();
        client.onClose(listener);

        // A real `ws` 'close' event always carries the close code as its first argument; 1006 is the code for an
        // abnormal closure such as `terminate()` with no close handshake — the shape a suspended-then-revoked
        // Desktop connection produces (see https://github.com/tjx666/caxri/issues/553).
        socket.emit('close', 1006);

        expect(listener).toHaveBeenCalledWith(undefined, 1006);
    });

    it('omits the close code for an explicit local close()', () => {
        const { client } = createAttachedClient();
        const listener = vi.fn();
        client.onClose(listener);

        client.close();

        expect(listener).toHaveBeenCalledWith(undefined, undefined);
    });
});

describe('ServerClient.renewLeaseNow', () => {
    it('sends an immediate lease renewal for the current generation', () => {
        const { client, socket } = createAttachedClient({
            desktopLease: { desktopId: 'desktop-1', generation: 7, expiresAt: 1 },
        });
        socket.send.mockClear();

        client.renewLeaseNow();

        expect(socket.send).toHaveBeenCalledTimes(1);
        const [payload] = socket.send.mock.calls[0] as [string];
        expect(JSON.parse(payload)).toEqual({ type: 'desktop-lease.renew', generation: 7 });
    });

    it('is a no-op without an active Desktop lease', () => {
        const { client, socket } = createAttachedClient();
        socket.send.mockClear();

        client.renewLeaseNow();

        expect(socket.send).not.toHaveBeenCalled();
    });

    it('is a no-op after the connection has closed', () => {
        const { client, socket } = createAttachedClient({
            desktopLease: { desktopId: 'desktop-1', generation: 7, expiresAt: 1 },
        });
        client.close();
        socket.send.mockClear();

        client.renewLeaseNow();

        expect(socket.send).not.toHaveBeenCalled();
    });

    /**
     * Regression coverage for https://github.com/tjx666/caxri/issues/553's follow-up: `renewLeaseNow()` is called
     * fire-and-forget from Electron's `powerMonitor` `resume` handler. When the socket already reports a non-OPEN state
     * after sleep, `send()` must not drop the renewal silently; it tears down the transport so the existing reconnect
     * path (driven by the `close` listener) takes over. A socket that still reports OPEN while half-open is not
     * detectable here; the Server's lease-expiry ping probe covers that case.
     */
    it('closes the transport instead of silently dropping the renewal when the socket is not open', () => {
        const { client, socket } = createAttachedClient({
            desktopLease: { desktopId: 'desktop-1', generation: 7, expiresAt: 1 },
        });
        socket.readyState = 3; // ws.CLOSED
        socket.send.mockClear();

        client.renewLeaseNow();

        expect(socket.send).not.toHaveBeenCalled();
        expect(socket.terminate).toHaveBeenCalledTimes(1);
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
                        features: [],
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

            /**
             * The resumed socket can deliver the queued control frame on the next event-loop turn.
             */
            await vi.waitFor(() => expect(closed.mock.calls[0]?.[0]).toBe('replaced'));
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

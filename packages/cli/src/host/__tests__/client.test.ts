import { createHash } from 'node:crypto';
import type * as fsPromises from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it, vi } from 'vitest';

const readFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => ({
    ...(await importOriginal<typeof fsPromises>()),
    readFile: readFileMock,
}));

import { discoverHostManifest, ensureHost, HostClient } from '../client';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    vi.restoreAllMocks();
    readFileMock.mockReset();
    const pending = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pending.map((path) => rm(path, { recursive: true, force: true })));
});

describe('HostClient close notification', () => {
    /**
     * The constructor is TypeScript-private (real attachments go through `HostClient.connect`), so this narrow
     * lifecycle test instantiates it directly with a socket stand-in.
     */
    function createAttachedClient() {
        const listeners = new Map<string, Array<(...arguments_: unknown[]) => void>>();
        const socket = {
            destroy: vi.fn(() => socket.emit('close')),
            emit(name: string, ...arguments_: unknown[]): void {
                const registered = listeners.get(name) ?? [];
                for (const listener of registered) listener(...arguments_);
            },
            on(name: string, listener: (...arguments_: unknown[]) => void) {
                listeners.set(name, [...(listeners.get(name) ?? []), listener]);
                return socket;
            },
            write: vi.fn(),
        };
        const construct = HostClient as unknown as new (
            socket: unknown,
            welcome: unknown,
            timeoutMs: number,
        ) => HostClient;
        return { client: new construct(socket, { protocolVersion: 1 }, 1000), socket };
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
});

describe('Host discovery', () => {
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

        await expect(discoverHostManifest(userDataPath)).rejects.toMatchObject({
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
                endpoint: join(hostDirectory, 'host.sock'),
                manifestVersion: 1,
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
            ensureHost(
                userDataPath,
                { executable: join(directory, 'missing-electron'), entryPath: '/app/host.js' },
                100,
            ),
        ).rejects.toMatchObject({
            code: 'UNAVAILABLE',
            message: 'Caxri Host process failed to launch',
        });
    });
});

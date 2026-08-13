import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandAdapter } from '../../shared/ipc/dispatcher';
import { localServerWelcomeSchema } from '../../shared/ipc/local-transport';
import { CAXRI_PROTOCOL_VERSION } from '../../shared/ipc/version';
import { LocalHostServer } from '../local-server';
import { acquireHostProfile } from '../profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function profile() {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-host-server-'));
    const socketDirectory = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
    const lease = await acquireHostProfile({ socketDirectory, userDataPath, version: '1.0.0' });
    cleanups.push(async () => {
        await lease.release();
        await rm(userDataPath, { recursive: true, force: true });
    });
    return lease;
}

function lineReader(socket: Socket) {
    let source = '';
    const pending: Array<(value: unknown) => void> = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
        source += chunk;
        let newline = source.indexOf('\n');
        while (newline !== -1) {
            pending.shift()?.(JSON.parse(source.slice(0, newline)) as unknown);
            source = source.slice(newline + 1);
            newline = source.indexOf('\n');
        }
    });
    return () => new Promise<unknown>((resolve) => pending.push(resolve));
}

async function connect(path: string): Promise<Socket> {
    const socket = createConnection(path);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    cleanups.push(() => {
        socket.destroy();
        return Promise.resolve();
    });
    return socket;
}

describe('local Host transport', () => {
    it('authenticates in constant-shape handshake and dispatches a Host command', async () => {
        const lease = await profile();
        const host: CommandAdapter = {
            invoke: (request) => {
                if (request.method === 'app.health')
                    return { ready: true, pid: 88, startedAt: 1, activePtyCount: 0 };
                return null;
            },
        };
        const counts: number[] = [];
        const server = new LocalHostServer({
            adapters: { host },
            manifest: lease.manifest,
            onClientCountChanged: (count) => counts.push(count),
        });
        await server.start();
        await lease.publish();
        cleanups.push(() => server.close());
        expect((await stat(lease.paths.endpoint)).mode & 0o777).toBe(0o600);

        const socket = await connect(lease.paths.endpoint);
        const read = lineReader(socket);
        socket.write(
            `${JSON.stringify({
                type: 'hello',
                supportedVersions: [1],
                profileId: lease.manifest.profileId,
                ownerToken: lease.manifest.ownerToken,
                clientKind: 'human-cli',
            })}\n`,
        );
        const welcome = localServerWelcomeSchema.parse(await read());
        expect(welcome.type).toBe('welcome');
        expect(welcome.principal.kind).toBe('human-cli');
        expect(welcome.capabilities).toEqual(['events.read', 'host.read', 'host.stop']);
        expect(welcome.commands).toContain('app.health');
        expect(welcome.commands).toContain('host.status');
        expect(welcome.commands).toContain('host.stop');
        socket.write(
            `${JSON.stringify({
                type: 'command',
                request: {
                    protocolVersion: CAXRI_PROTOCOL_VERSION,
                    id: 'health-1',
                    method: 'app.health',
                    params: {},
                },
            })}\n`,
        );
        await expect(read()).resolves.toMatchObject({
            type: 'reply',
            reply: { id: 'health-1', ok: true, result: { pid: 88 } },
        });
        expect(counts).toContain(1);
    });

    it('rejects the wrong profile token without invoking an application handler', async () => {
        const lease = await profile();
        const invoke = vi.fn();
        const server = new LocalHostServer({
            adapters: { host: { invoke } },
            manifest: lease.manifest,
        });
        await server.start();
        cleanups.push(() => server.close());
        const socket = await connect(lease.paths.endpoint);
        socket.write(
            `${JSON.stringify({
                type: 'hello',
                supportedVersions: [1],
                profileId: lease.manifest.profileId,
                ownerToken: '0'.repeat(64),
                clientKind: 'human-cli',
            })}\n`,
        );
        await new Promise<void>((resolve) => socket.once('close', () => resolve()));
        expect(invoke).not.toHaveBeenCalled();
    });

    it('fails closed when the client has no compatible protocol version', async () => {
        const lease = await profile();
        const server = new LocalHostServer({
            adapters: { host: { invoke: vi.fn() } },
            manifest: lease.manifest,
        });
        await server.start();
        cleanups.push(() => server.close());
        const socket = await connect(lease.paths.endpoint);
        socket.write(
            `${JSON.stringify({
                type: 'hello',
                supportedVersions: [2],
                profileId: lease.manifest.profileId,
                ownerToken: lease.manifest.ownerToken,
                clientKind: 'human-cli',
            })}\n`,
        );
        await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    });
});

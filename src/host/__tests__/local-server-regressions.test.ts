import { mkdtemp, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { HostClient } from '../../../packages/cli/src/host';
import type { CommandAdapter } from '../../shared/ipc/dispatcher';
import { localServerWelcomeSchema } from '../../shared/ipc/local-transport';
import { CAXRI_PROTOCOL_VERSION } from '../../shared/ipc/version';
import { LocalHostServer } from '../local-server';
import { acquireHostProfile } from '../profile';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    const cleanupsToRun = cleanups.slice();
    cleanups.length = 0;
    await Promise.all(cleanupsToRun.map((cleanup) => cleanup()));
});

async function profile() {
    const userDataPath = await mkdtemp(join(tmpdir(), 'caxri-host-regression-'));
    const socketDirectory = process.platform === 'darwin' ? '/private/tmp' : '/tmp';
    const lease = await acquireHostProfile({ socketDirectory, userDataPath, version: '1.0.0' });
    cleanups.push(async () => {
        await lease.release();
        await rm(userDataPath, { recursive: true, force: true });
    });
    return lease;
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

function lineReader(socket: Socket) {
    let source = '';
    const values: unknown[] = [];
    const pending: Array<{ reject(error: Error): void; resolve(value: unknown): void }> = [];
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
        source += chunk;
        let newline = source.indexOf('\n');
        while (newline !== -1) {
            const value = JSON.parse(source.slice(0, newline)) as unknown;
            source = source.slice(newline + 1);
            const waiter = pending.shift();
            if (waiter) waiter.resolve(value);
            else values.push(value);
            newline = source.indexOf('\n');
        }
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
    return `${JSON.stringify({
        type: 'command',
        request: { protocolVersion: CAXRI_PROTOCOL_VERSION, id, method, params: parameters },
    })}\n`;
}

describe('local Host transport regressions', () => {
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
        const server = new LocalHostServer({
            adapters: { host },
            desktopCredential: lease.desktopCredential,
            manifest: lease.manifest,
        });
        await server.start();
        cleanups.push(() => server.close());

        const client = await HostClient.connect(lease.manifest, 5_000, {
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

    it('renews the Desktop lease while an ordered business request is still running', async () => {
        const lease = await profile();
        const nativeSetTimeout = setTimeout.bind(globalThis);
        const { promise: readStarted, resolve: releaseRead } = Promise.withResolvers<void>();
        const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
        const host: CommandAdapter = {
            invoke: async (request) => {
                if (request.method === 'files.read') {
                    markStarted();
                    await readStarted;
                    return { path: '/project/a.txt', content: 'done', mtimeMs: 1, size: 4 };
                }
                return null;
            },
        };
        const server = new LocalHostServer({
            adapters: { host },
            desktopCredential: lease.desktopCredential,
            desktopLeaseDurationMs: 500,
            manifest: lease.manifest,
        });
        await server.start();
        cleanups.push(() => server.close());

        const socket = await connect(lease.paths.endpoint);
        const read = lineReader(socket);
        socket.write(
            `${JSON.stringify({
                type: 'hello',
                supportedVersions: [CAXRI_PROTOCOL_VERSION],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'desktop',
                    token: lease.desktopCredential.desktopToken,
                    desktopId: 'desktop-slow-request',
                },
            })}\n`,
        );
        const welcome = localServerWelcomeSchema.parse(await read());
        const generation = welcome.desktopLease!.generation;
        socket.write(command('slow-read', 'files.read', { sessionId: 'session-1', path: 'a.txt' }));
        await started;

        await new Promise((resolve) => nativeSetTimeout(resolve, 250));
        socket.write(`${JSON.stringify({ type: 'desktop-lease.renew', generation })}\n`);
        await expect(
            Promise.race([
                read(),
                new Promise((_resolve, reject) =>
                    nativeSetTimeout(() => reject(new Error('Lease renewal was queued')), 200),
                ),
            ]),
        ).resolves.toMatchObject({ type: 'desktop-lease.renewed' });

        await new Promise((resolve) => nativeSetTimeout(resolve, 300));
        releaseRead();
        await expect(read()).resolves.toMatchObject({
            type: 'reply',
            reply: { id: 'slow-read', ok: true },
        });
        socket.write(command('health-after-renewal', 'app.health', {}));
        await expect(read()).resolves.toMatchObject({
            type: 'reply',
            reply: { id: 'health-after-renewal' },
        });
    });
});

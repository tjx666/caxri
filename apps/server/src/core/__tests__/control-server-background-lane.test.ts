import { Buffer } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommandAdapter, ServerControlEndpoint } from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    localServerWelcomeSchema,
    serverEndpointUrl,
} from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { ControlServer } from '../control-server';
import type { ControlServerOptions } from '../control-server-support';
import { acquireServerProfile } from '../profile';

/**
 * Owns the background lane of the all-Session Workbench Root sweep. The fixtures below (`profile`, `connect`,
 * `messageReader`, `command`) intentionally mirror the sibling lane tests rather than being shared.
 */
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

describe('Workbench Root sweep in the background lane', () => {
    async function connectDesktop(
        host: CommandAdapter,
        invokeDesktopOperation: ControlServerOptions['invokeDesktopOperation'],
    ) {
        const lease = await profile();
        const server = new ControlServer({
            adapters: { server: host },
            invokeDesktopOperation,
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
                clientId: 'desktop-background-lane',
                supportedVersions: [CAXRI_PROTOCOL_VERSION],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'desktop',
                    token: lease.desktopCredential.desktopToken,
                    desktopId: 'desktop-background-lane',
                },
            })}\n`,
        );
        localServerWelcomeSchema.parse(await read());
        return { read, server, socket };
    }

    /**
     * Desktop Main reaches the sweep through the `desktop-runtime-command` bridge, not the public command table. The
     * operation blocks while `shouldBlock(params)` matches until `release` resolves; `session.select` stays instant.
     */
    function sweepHost(shouldBlock: (parameters: unknown) => boolean) {
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const invoked: string[] = [];
        const host: CommandAdapter = {
            invoke: (request) => {
                invoked.push(request.method);
                return Promise.resolve(null);
            },
        };
        const invokeDesktopOperation: ControlServerOptions['invokeDesktopOperation'] = async (
            request,
        ) => {
            invoked.push(request.method);
            if (
                request.method === 'session.validateWorkbenchRoots' &&
                shouldBlock(request.params)
            ) {
                started.resolve();
                await release.promise;
            }
            return null;
        };
        return { host, invoked, invokeDesktopOperation, release, started };
    }

    function sweepCommand(id: string, parameters: unknown) {
        return JSON.stringify({
            type: 'desktop-runtime-command',
            request: {
                protocolVersion: CAXRI_PROTOCOL_VERSION,
                id,
                method: 'session.validateWorkbenchRoots',
                params: parameters,
            },
        });
    }

    async function drainTurns(): Promise<void> {
        for (let tick = 0; tick < 5; tick += 1)
            // eslint-disable-next-line no-await-in-loop -- each turn must drain before the next one is scheduled
            await new Promise<void>((resolve) => setImmediate(resolve));
    }

    /**
     * Production logged 10 Session switches queued 300-530ms (twice about 7s) behind a focus-driven sweep that Desktop
     * Main sends on every activation and ignores the reply of.
     */
    it('lets a Session switch pass a running all-Session sweep, then answers the sweep', async () => {
        const sweep = sweepHost(() => true);
        const { read, socket } = await connectDesktop(sweep.host, sweep.invokeDesktopOperation);
        socket.send(sweepCommand('sweep', {}));
        await sweep.started.promise;
        socket.send(command('select', 'session.select', { sessionId: 'session-2' }));
        await expect(read()).resolves.toMatchObject({ reply: { id: 'select' } });
        sweep.release.resolve();
        await expect(read()).resolves.toMatchObject({ reply: { id: 'sweep' } });
    });

    it('keeps the per-Session form in the ordered lane', async () => {
        const sweep = sweepHost(
            (parameters) => (parameters as { sessionId?: string }).sessionId === 's1',
        );
        const { read, socket } = await connectDesktop(sweep.host, sweep.invokeDesktopOperation);
        socket.send(sweepCommand('one', { sessionId: 's1' }));
        await sweep.started.promise;
        socket.send(command('select', 'session.select', { sessionId: 'session-2' }));
        await drainTurns();
        expect(sweep.invoked).toEqual(['session.validateWorkbenchRoots']);
        sweep.release.resolve();
        await expect(read()).resolves.toMatchObject({ reply: { id: 'one' } });
        await expect(read()).resolves.toMatchObject({ reply: { id: 'select' } });
    });

    it('runs two sweeps from one connection one at a time', async () => {
        const sweep = sweepHost(() => true);
        const { read, socket } = await connectDesktop(sweep.host, sweep.invokeDesktopOperation);
        socket.send(sweepCommand('first', {}));
        await sweep.started.promise;
        socket.send(sweepCommand('second', {}));
        await drainTurns();
        expect(sweep.invoked).toEqual(['session.validateWorkbenchRoots']);
        sweep.release.resolve();
        await expect(read()).resolves.toMatchObject({ reply: { id: 'first' } });
        await expect(read()).resolves.toMatchObject({ reply: { id: 'second' } });
    });

    it('waits for a running sweep and the one queued behind it before close resolves', async () => {
        const sweep = sweepHost(() => true);
        const { server, socket } = await connectDesktop(sweep.host, sweep.invokeDesktopOperation);
        socket.send(sweepCommand('first', {}));
        await sweep.started.promise;
        socket.send(sweepCommand('second', {}));
        await drainTurns();
        let isClosed = false;
        const closing = (async () => {
            await server.close();
            isClosed = true;
        })();
        await drainTurns();
        expect(isClosed).toBe(false);
        sweep.release.resolve();
        await closing;
        expect(isClosed).toBe(true);
        expect(
            sweep.invoked.filter((method) => method === 'session.validateWorkbenchRoots'),
        ).toHaveLength(2);
    });
});

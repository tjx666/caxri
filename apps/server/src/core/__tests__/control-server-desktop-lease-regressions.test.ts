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
import { acquireServerProfile } from '../profile';

/**
 * Split out of `control-server-regressions.test.ts` to keep both files under the repository's `max-lines` budget. This
 * file owns the Desktop-lease-lifecycle wire-protocol regressions specifically; the fixtures below (`profile`,
 * `connect`, `messageReader`, `command`) intentionally mirror the sibling file rather than being shared, since the
 * sibling covers unrelated transport concerns and a shared test-support module would couple the two for no benefit.
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

describe('Desktop lease regressions', () => {
    it('renews the Desktop lease while an ordered business request is still running', async () => {
        const lease = await profile();
        const nativeSetTimeout = setTimeout.bind(globalThis);
        const { promise: readStarted, resolve: releaseRead } = Promise.withResolvers<void>();
        const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
        const host: CommandAdapter = {
            invoke: async (request) => {
                if (request.method === 'app.health') {
                    markStarted();
                    await readStarted;
                    return { ready: true, pid: 88, startedAt: 1, activePtyCount: 0 };
                }
                return null;
            },
        };
        const server = new ControlServer({
            adapters: { server: host },
            desktopCredential: lease.desktopCredential,
            desktopLeaseDurationMs: 500,
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
                    desktopId: 'desktop-slow-request',
                },
            })}\n`,
        );
        const welcome = localServerWelcomeSchema.parse(await read());
        const generation = welcome.desktopLease!.generation;
        socket.send(command('slow-health', 'app.health', {}));
        await started;

        await new Promise((resolve) => nativeSetTimeout(resolve, 250));
        socket.send(JSON.stringify({ type: 'desktop-lease.renew', generation }));
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
            reply: { id: 'slow-health', ok: true },
        });
        socket.send(command('health-after-renewal', 'app.health', {}));
        await expect(read()).resolves.toMatchObject({
            type: 'reply',
            reply: { id: 'health-after-renewal' },
        });
    });

    /**
     * Regression coverage for https://github.com/tjx666/caxri/issues/553: a suspended-then-woken Desktop process can
     * miss its lease-renewal tick, so the lease timer alone must not revoke on its first expiry. These tests pin the
     * grace-window behavior directly against the wire protocol instead of the internal timer plumbing.
     */
    it('revokes the Desktop lease only after the post-expiry grace window also elapses without a renewal', async () => {
        const lease = await profile();
        const unavailable = vi.fn();
        const server = new ControlServer({
            adapters: { server: { invoke: () => null } },
            desktopCredential: lease.desktopCredential,
            desktopLeaseDurationMs: 150,
            desktopLeaseGraceMs: 150,
            identity: lease.identity,
            onDesktopUnavailable: unavailable,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());

        const socket = await connect(lease.manifest.endpoint);
        const read = messageReader(socket);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'desktop-dead',
                supportedVersions: [CAXRI_PROTOCOL_VERSION],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'desktop',
                    token: lease.desktopCredential.desktopToken,
                    desktopId: 'desktop-dead',
                },
            })}\n`,
        );
        await read();
        // Simulate a genuinely frozen Desktop process: pausing the underlying socket stops it from reading (and
        // therefore auto-answering) the Server's liveness `ping()`, so this stays a valid "no pong ever arrives"
        // case even though the TCP connection itself is technically still alive.
        socket.pause();

        // Never renews. The lease timer (150ms) fires and only enters grace; the Desktop must still be current
        // partway through the grace window.
        await new Promise((resolve) => setTimeout(resolve, 220));
        expect(unavailable).not.toHaveBeenCalled();
        expect(server.clientCount()).toBe(1);

        // Once lease + grace (300ms) has fully elapsed without a renewal or a pong, the Desktop is a genuinely dead
        // client and must be revoked.
        await vi.waitFor(() => expect(unavailable).toHaveBeenCalledTimes(1));
        expect(server.clientCount()).toBe(0);
    });

    it('recovers the Desktop lease from an automatic pong when no renewal message ever arrives', async () => {
        const lease = await profile();
        const unavailable = vi.fn();
        const server = new ControlServer({
            adapters: { server: { invoke: () => null } },
            desktopCredential: lease.desktopCredential,
            desktopLeaseDurationMs: 150,
            desktopLeaseGraceMs: 300,
            identity: lease.identity,
            onDesktopUnavailable: unavailable,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());

        const socket = await connect(lease.manifest.endpoint);
        const read = messageReader(socket);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'desktop-woken',
                supportedVersions: [CAXRI_PROTOCOL_VERSION],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'desktop',
                    token: lease.desktopCredential.desktopToken,
                    desktopId: 'desktop-woken',
                },
            })}\n`,
        );
        await read();
        // Deliberately never send `desktop-lease.renew`. The socket is left open and unpaused so `ws` answers the
        // Server's liveness `ping()` automatically at the protocol level, mirroring a Desktop whose wake-triggered
        // `renewLeaseNow()` never reached the wire but whose event loop and socket are otherwise live.

        // Past the original lease window (150ms) but before lease + grace (450ms), the pong must already have
        // renewed the lease.
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(unavailable).not.toHaveBeenCalled();
        expect(server.clientCount()).toBe(1);

        // Well past the original lease + grace window, the pong-driven renewal must still hold: no revocation.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(unavailable).not.toHaveBeenCalled();
        expect(server.clientCount()).toBe(1);
    });

    it('keeps the Desktop lease alive when a renewal arrives during the post-expiry grace window', async () => {
        const lease = await profile();
        const unavailable = vi.fn();
        const server = new ControlServer({
            adapters: { server: { invoke: () => null } },
            desktopCredential: lease.desktopCredential,
            desktopLeaseDurationMs: 150,
            desktopLeaseGraceMs: 300,
            identity: lease.identity,
            onDesktopUnavailable: unavailable,
        });
        await lease.publish(await server.start());
        cleanups.push(() => server.close());

        const socket = await connect(lease.manifest.endpoint);
        const read = messageReader(socket);
        socket.send(
            `${JSON.stringify({
                type: 'hello',
                clientId: 'desktop-suspended',
                supportedVersions: [CAXRI_PROTOCOL_VERSION],
                profileId: lease.manifest.profileId,
                credential: {
                    kind: 'desktop',
                    token: lease.desktopCredential.desktopToken,
                    desktopId: 'desktop-suspended',
                },
            })}\n`,
        );
        const welcome = localServerWelcomeSchema.parse(await read());
        const generation = welcome.desktopLease!.generation;

        // Simulate a Desktop that missed its 20s background renewal tick because the whole process was suspended:
        // let the 150ms lease timer fire and enter grace, then renew mid-grace instead of on the original schedule.
        await new Promise((resolve) => setTimeout(resolve, 200));
        socket.send(JSON.stringify({ type: 'desktop-lease.renew', generation }));
        await expect(read()).resolves.toMatchObject({ type: 'desktop-lease.renewed' });

        // Past the original lease + grace window (450ms from hello), the late-but-in-grace renewal must have
        // cancelled the revocation.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(unavailable).not.toHaveBeenCalled();
        expect(server.clientCount()).toBe(1);
    });
});

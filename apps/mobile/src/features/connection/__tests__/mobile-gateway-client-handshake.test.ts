import { MOBILE_TRANSPORT_VERSION, serializeMobilePairingLink } from '@caxri/mobile-transport';
import { describe, expect, it, vi } from 'vitest';

import type { MobileGatewayRuntime } from '../mobile-gateway-client';
import { pairMobileGateway, reconnectMobileGateway } from '../mobile-gateway-client';
import {
    AndroidConnectingSocket,
    FakeGatewaySocket,
    flushTasks,
    memoryStore,
    mobileCredential,
    NeverOpenSocket,
    observeSettlement,
    pairingLink,
    pairingSecret,
    serverId,
    VersionMismatchSocket,
} from './mobile-gateway-fixture';

/**
 * Opening a gateway socket: racing candidate addresses, open deadlines, cancellation, and transport version checks.
 */
describe('mobile gateway client handshake', () => {
    it('closes a pending handshake immediately when its owner cancels', async () => {
        const socket = new NeverOpenSocket();
        const cancellation = new AbortController();
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const attempt = pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            signal: cancellation.signal,
            store,
        });
        cancellation.abort();
        await expect(attempt).rejects.toThrow();
        expect(socket.isClosed).toBe(true);
        await expect(store.load()).resolves.toBeNull();
    });

    it('stops waiting for a socket to open after four seconds', async () => {
        const socket = new NeverOpenSocket();
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        vi.useFakeTimers();
        try {
            let isSettled = false;
            const attempt = observeSettlement(
                pairMobileGateway({
                    displayName: 'Pixel fixture',
                    pairingLink,
                    runtime,
                    store,
                }),
                () => {
                    isSettled = true;
                },
            );
            await vi.advanceTimersByTimeAsync(4_000);
            expect(isSettled).toBe(true);
            expect(socket.isClosed).toBe(true);
            await attempt;
        } finally {
            socket.close();
            await vi.advanceTimersByTimeAsync(10_000);
            vi.useRealTimers();
        }
    });

    it('races eligible sockets but sends the one-time pairing handshake only to the winner', async () => {
        const sockets: FakeGatewaySocket[] = [];
        const runtime: MobileGatewayRuntime = {
            openWebSocket: (url) => {
                const socket = new FakeGatewaySocket(false, url.includes('192.168.1.5') ? 20 : 0);
                sockets.push(socket);
                return socket as unknown as WebSocket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const link = serializeMobilePairingLink({
            version: MOBILE_TRANSPORT_VERSION,
            addresses: ['192.168.1.5', '192.168.1.6'],
            port: 41_337,
            serverId,
            pairingId: '11'.repeat(16),
            secret: pairingSecret,
            expiresAt: Date.now() + 60_000,
        });

        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink: link,
            runtime,
            store,
        });

        expect(sockets).toHaveLength(2);
        expect(sockets[0]?.helloCount).toBe(0);
        expect(sockets[0]?.isClosed).toBe(true);
        expect(sockets[1]?.helloCount).toBe(1);
        paired.connection.close('unmounted');
    });

    it('closes a race loser that Android opens after the winner, without sending it a hello', async () => {
        const loser = new AndroidConnectingSocket();
        const winner = new FakeGatewaySocket();
        const runtime: MobileGatewayRuntime = {
            openWebSocket: (url) =>
                (url.includes('192.168.1.5') ? loser : winner) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const link = serializeMobilePairingLink({
            version: MOBILE_TRANSPORT_VERSION,
            addresses: ['192.168.1.5', '192.168.1.6'],
            port: 41_337,
            serverId,
            pairingId: '11'.repeat(16),
            secret: pairingSecret,
            expiresAt: Date.now() + 60_000,
        });

        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink: link,
            runtime,
            store,
        });
        loser.open();
        await flushTasks();

        expect(winner.helloCount).toBe(1);
        expect(loser.sent).toEqual([]);
        expect(loser.isClosed).toBe(true);
        paired.connection.close('unmounted');
    });

    it('closes a socket that Android opens after its open deadline passed', async () => {
        const socket = new AndroidConnectingSocket();
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        vi.useFakeTimers();
        try {
            const attempt = pairMobileGateway({
                displayName: 'Pixel fixture',
                pairingLink,
                runtime,
                store,
            });
            const outcome = expect(attempt).rejects.toMatchObject({ code: 'unreachable' });
            await vi.advanceTimersByTimeAsync(4_000);
            await outcome;
            socket.open();
            await vi.advanceTimersByTimeAsync(0);

            expect(socket.sent).toEqual([]);
            expect(socket.isClosed).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('never sends the pairing hello to a socket Android opens after its owner cancelled', async () => {
        const socket = new AndroidConnectingSocket();
        const cancellation = new AbortController();
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const attempt = pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            signal: cancellation.signal,
            store,
        });
        const outcome = expect(attempt).rejects.toThrow();
        cancellation.abort();
        socket.open();
        await flushTasks();

        expect(socket.sent).toEqual([]);
        expect(socket.isClosed).toBe(true);
        await outcome;
        await expect(store.load()).resolves.toBeNull();
    });

    it('classifies a version-mismatch response as terminal during reconnect', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new VersionMismatchSocket() as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        await store.save(mobileCredential);

        await expect(reconnectMobileGateway(mobileCredential, runtime, store)).rejects.toEqual(
            expect.objectContaining({
                code: 'version-mismatch',
                isDesktopNewer: false,
                supportedVersion: 1,
            }),
        );
        await expect(store.load()).resolves.toEqual(mobileCredential);
    });

    it('marks a mismatch from a newer Desktop as one update recovery can fix', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () =>
                new VersionMismatchSocket(MOBILE_TRANSPORT_VERSION + 1) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();

        await expect(reconnectMobileGateway(mobileCredential, runtime, store)).rejects.toEqual(
            expect.objectContaining({
                code: 'version-mismatch',
                isDesktopNewer: true,
                supportedVersion: MOBILE_TRANSPORT_VERSION + 1,
            }),
        );
    });

    it('classifies a version-mismatch response as terminal during pairing', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new VersionMismatchSocket() as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();

        await expect(
            pairMobileGateway({
                displayName: 'Pixel fixture',
                pairingLink,
                runtime,
                store,
            }),
        ).rejects.toEqual(expect.objectContaining({ code: 'version-mismatch' }));
        await expect(store.load()).resolves.toBeNull();
    });

    it('reports an incompatible pairing link as an update requirement before opening a socket', async () => {
        const openWebSocket = vi.fn();
        const runtime: MobileGatewayRuntime = {
            openWebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const incompatibleLink = new URL(pairingLink);
        incompatibleLink.searchParams.set('v', String(MOBILE_TRANSPORT_VERSION + 1));

        await expect(
            pairMobileGateway({
                displayName: 'Pixel fixture',
                pairingLink: incompatibleLink.href,
                runtime,
                store,
            }),
        ).rejects.toEqual(expect.objectContaining({ code: 'version-mismatch' }));
        expect(openWebSocket).not.toHaveBeenCalled();
    });
});

import { MOBILE_TRANSPORT_VERSION, serializeMobilePairingLink } from '@caxri/mobile-transport';
import { describe, expect, it, vi } from 'vitest';

import type {
    MobileGatewayConnection,
    MobileGatewayRuntime,
    MobileReconnectError,
} from '../mobile-gateway-client';
import { pairMobileGateway, reconnectMobileGateway } from '../mobile-gateway-client';
import {
    FakeGatewaySocket,
    memoryStore,
    mobileCredential,
    NeverOpenSocket,
    observeSettlement,
    pairingLink,
    pairingSecret,
    serverId,
    UnverifiedReconnectSocket,
    VersionMismatchSocket,
} from './mobile-gateway-fixture';

describe('mobile gateway client', () => {
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
        paired.connection.close();
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

    it('disconnects a half-open socket when an ordinary request times out', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket(false, 0, true) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));
        vi.useFakeTimers();
        try {
            const request = paired.connection.request('project.query', { mode: 'list' });
            const rejected = expect(request).rejects.toThrow('Caxri did not respond in time.');
            await vi.advanceTimersByTimeAsync(15_000);
            await rejected;
            await expect(termination).resolves.toBe('disconnected');
        } finally {
            vi.useRealTimers();
        }
    });

    it.each([
        [
            'dashboard',
            (connection: MobileGatewayConnection) => connection.request('mobile.dashboard'),
        ],
        [
            'Session detail',
            (connection: MobileGatewayConnection) =>
                connection.request('mobile.session.show', { sessionId: 'session-1' }),
        ],
        [
            'Agent availability',
            (connection: MobileGatewayConnection) =>
                connection.request('mobile.agent.availability', { projectId: 'project-1' }),
        ],
    ])('times out an idempotent %s read after three seconds', async (_name, request) => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket(false, 0, true) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        vi.useFakeTimers();
        try {
            let isSettled = false;
            const outcome = observeSettlement(request(paired.connection), () => {
                isSettled = true;
            });
            expect(paired.connection.hasOutstandingMutation()).toBe(false);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(isSettled).toBe(true);
            await outcome;
        } finally {
            paired.connection.close();
            vi.useRealTimers();
        }
    });

    it('keeps the longer deadline for a write while a network is slow', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket(false, 0, true) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        vi.useFakeTimers();
        try {
            let isSettled = false;
            const outcome = observeSettlement(
                paired.connection.request('session.markRead', {
                    sessionId: 'session-1',
                    attentionEpoch: 1,
                }),
                () => {
                    isSettled = true;
                },
            );
            expect(paired.connection.hasOutstandingMutation()).toBe(true);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(isSettled).toBe(false);
            await vi.advanceTimersByTimeAsync(12_000);
            expect(isSettled).toBe(true);
            await outcome;
            expect(paired.connection.hasOutstandingMutation()).toBe(false);
        } finally {
            paired.connection.close();
            vi.useRealTimers();
        }
    });

    it('bounds the foreground probe independently from the ordinary request timeout', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket(false, 0, true) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));
        vi.useFakeTimers();
        try {
            const probe = paired.connection.probe();
            const rejected = expect(probe).rejects.toThrow(
                'Caxri did not respond to the foreground probe.',
            );
            await vi.advanceTimersByTimeAsync(1_500);
            await rejected;
            await expect(termination).resolves.toBe('disconnected');
        } finally {
            vi.useRealTimers();
        }
    });

    it('pairs, persists only the durable credential, and sends a typed encrypted request', async () => {
        let randomByte = 128;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket() as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(randomByte++),
        };
        const { store, values } = memoryStore();

        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });

        expect(await store.load()).toEqual(paired.credential);
        expect(values.values().toArray().join('')).not.toContain(pairingSecret);
        await expect(paired.connection.request('project.query', { mode: 'list' })).resolves.toEqual(
            {
                view: 'paired-device',
                projects: [{ id: 'project-1', displayTitle: 'Fixture' }],
            },
        );
        paired.connection.close();
    });

    it('sends two requests before either reply and correlates reverse-order replies', async () => {
        const socket = new FakeGatewaySocket(false, 0, false, true);
        let randomByte = 128;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(randomByte++),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const first = paired.connection.request('project.query', { mode: 'list' });
        const second = paired.connection.request('project.query', { mode: 'list' });
        expect(socket.requestCount).toBe(2);
        socket.releaseHeldRequests();
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        paired.connection.close();
    });

    it('routes subscribed dashboard events separately from command replies and stops on unsubscribe', async () => {
        const socket = new FakeGatewaySocket();
        let randomByte = 128;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(randomByte++),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const onEvent = vi.fn();
        const subscription = await paired.connection.subscribe({ kind: 'dashboard' }, onEvent);
        socket.sendDashboardEvent(0);
        await vi.waitFor(() => expect(onEvent).toHaveBeenCalledOnce());
        await subscription.unsubscribe();
        socket.sendDashboardEvent(1);
        await Promise.resolve();
        expect(onEvent).toHaveBeenCalledOnce();
        paired.connection.close();
    });

    it('delivers a pre-ACK resync before subscribe resolves', async () => {
        const socket = new FakeGatewaySocket(false, 0, false, false, true);
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const onEvent = vi.fn();
        const handle = await paired.connection.subscribe({ kind: 'dashboard' }, onEvent);
        expect(onEvent).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ kind: 'resync-required', sequence: 0 }),
        );
        await handle.unsubscribe();
        paired.connection.close();
    });

    it('pauses heartbeats in background and resumes them on the foreground connection', async () => {
        const socket = new FakeGatewaySocket();
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        vi.useFakeTimers();
        try {
            paired.connection.setForeground(true);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(socket.heartbeatCount).toBe(1);
            paired.connection.setForeground(false);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(socket.heartbeatCount).toBe(1);
            paired.connection.setForeground(true);
            await vi.advanceTimersByTimeAsync(3_000);
            expect(socket.heartbeatCount).toBe(2);
        } finally {
            paired.connection.close();
            vi.useRealTimers();
        }
    });

    it('restarts the heartbeat after a valid reply saves an in-flight write from a deferred timeout', async () => {
        const socket = new FakeGatewaySocket(false, 0, false, true, false, true);
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const onTermination = vi.fn();
        paired.connection.onTermination(onTermination);
        vi.useFakeTimers();
        try {
            paired.connection.setForeground(true);
            const write = paired.connection.request('project.query', { mode: 'list' });
            await vi.advanceTimersByTimeAsync(8_000);
            expect(onTermination).not.toHaveBeenCalled();
            socket.releaseHeldRequests();
            await expect(write).resolves.toMatchObject({ view: 'paired-device' });
            await vi.advanceTimersByTimeAsync(3_000);
            expect(socket.heartbeatCount).toBe(2);
        } finally {
            paired.connection.close();
            vi.useRealTimers();
        }
    });

    it('closes after concurrent writes settle when one timed out despite an intervening valid heartbeat', async () => {
        const socket = new FakeGatewaySocket(false, 0, false, true);
        let randomByte = 128;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => socket as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(randomByte++),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const onTermination = vi.fn();
        paired.connection.onTermination(onTermination);
        vi.useFakeTimers();
        try {
            const first = paired.connection.request('project.query', { mode: 'list' });
            const firstRejected = expect(first).rejects.toThrow('Caxri did not respond in time.');
            await vi.advanceTimersByTimeAsync(1_000);
            const second = paired.connection.request('project.query', { mode: 'list' });
            expect(socket.requestCount).toBe(2);
            await vi.advanceTimersByTimeAsync(14_000);
            await firstRejected;
            expect(onTermination).not.toHaveBeenCalled();
            socket.sendHeartbeatAck();
            await Promise.resolve();
            const retry = paired.connection.request('project.query', { mode: 'list' });
            const retryRejected = expect(retry).rejects.toThrow('Caxri did not respond in time.');
            expect(socket.requestCount).toBe(2);
            socket.releaseHeldRequestAt(1);
            await expect(second).resolves.toMatchObject({ view: 'paired-device' });
            await retryRejected;
            expect(onTermination).toHaveBeenCalledExactlyOnceWith('disconnected');
            expect(socket.isClosed).toBe(true);
        } finally {
            paired.connection.close();
            vi.useRealTimers();
        }
    });

    it('clears the durable credential only after an authenticated revoked payload', async () => {
        let socket: FakeGatewaySocket | undefined;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => {
                socket = new FakeGatewaySocket();
                return socket as unknown as WebSocket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));

        socket?.sendRevoked();

        await expect(termination).resolves.toBe('revoked');
        await expect(store.load()).resolves.toBeNull();
        const lateListener = vi.fn();
        paired.connection.onTermination(lateListener);
        expect(lateListener).toHaveBeenCalledExactlyOnceWith('revoked');
    });

    it('consumes a delivered revoked payload when the peer closes during pairing handoff', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket(true) as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));

        await expect(termination).resolves.toBe('revoked');
        await expect(store.load()).resolves.toBeNull();
    });

    it('preserves the durable credential when an unauthenticated frame imitates revocation', async () => {
        let socket: FakeGatewaySocket | undefined;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => {
                socket = new FakeGatewaySocket();
                return socket as unknown as WebSocket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));

        socket?.sendRevoked(false);

        await expect(termination).resolves.toBe('disconnected');
        await expect(store.load()).resolves.toEqual(paired.credential);
    });

    it('terminates and clears a pending request when the socket send fails synchronously', async () => {
        let socket: FakeGatewaySocket | undefined;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => {
                socket = new FakeGatewaySocket();
                return socket as unknown as WebSocket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        const paired = await pairMobileGateway({
            displayName: 'Pixel fixture',
            pairingLink,
            runtime,
            store,
        });
        const termination = new Promise((resolve) => paired.connection.onTermination(resolve));
        socket?.failNextSealedSend();

        await expect(paired.connection.request('project.query', { mode: 'list' })).rejects.toThrow(
            'Fixture send failed',
        );
        await expect(termination).resolves.toBe('disconnected');
        await expect(store.load()).resolves.toEqual(paired.credential);
    });

    it('classifies an unverifiable reconnect without clearing the stored credential', async () => {
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new UnverifiedReconnectSocket() as unknown as WebSocket,
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        await store.save(mobileCredential);

        await expect(reconnectMobileGateway(mobileCredential, runtime, store)).rejects.toEqual(
            expect.objectContaining<Partial<MobileReconnectError>>({ code: 'unverified' }),
        );
        await expect(store.load()).resolves.toEqual(mobileCredential);
    });
});

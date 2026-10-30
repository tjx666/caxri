import { mobileClientCloseReasons } from '@caxri/mobile-transport';
import { describe, expect, it, vi } from 'vitest';

import type { MobileGatewayRouteKind } from '../gateway-routes';
import { SHORT_DIRECT_ROUTE_GRACE_MS } from '../gateway-routes';
import type { MobileGatewayRuntime, MobileReconnectError } from '../mobile-gateway-client';
import { pairMobileGateway, reconnectMobileGateway } from '../mobile-gateway-client';
import type { MobileGatewayConnection } from '../mobile-gateway-connection';
import {
    FakeGatewaySocket,
    flushTasks,
    memoryStore,
    mobileCredential,
    observeSettlement,
    pairingLink,
    pairingSecret,
} from './mobile-gateway-fixture';
import { ConnectGatewaySocket, UnverifiedReconnectSocket } from './reconnect-gateway-fixture';

/**
 * Opens one reconnect peer per dial, created at dial time so its open event reaches the route's listener.
 */
const reconnectThrough = (ready?: ConstructorParameters<typeof ConnectGatewaySocket>[0]) => {
    const saved: MobileGatewayRouteKind[] = [];
    const sockets: ConnectGatewaySocket[] = [];
    const runtime: MobileGatewayRuntime = {
        openWebSocket: () => {
            const socket = new ConnectGatewaySocket(ready);
            sockets.push(socket);
            return socket as unknown as WebSocket;
        },
        platform: 'android',
        randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        routeHints: {
            load: async () => {
                await Promise.resolve();
                return saved.at(-1);
            },
            save: (_serverId, route) => saved.push(route),
        },
    };
    const socket = (): ConnectGatewaySocket => {
        const [only] = sockets as [ConnectGatewaySocket?];
        if (!only || sockets.length !== 1) throw new Error('Expected exactly one dial.');
        return only;
    };
    return { runtime, saved, socket };
};

describe('mobile gateway client', () => {
    it('disconnects a half-open socket when an ordinary request times out', async () => {
        let socket: FakeGatewaySocket | undefined;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => {
                socket = new FakeGatewaySocket(false, 0, true);
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
        vi.useFakeTimers();
        try {
            const request = paired.connection.request('project.query', { mode: 'list' });
            const rejected = expect(request).rejects.toThrow('Caxri did not respond in time.');
            await vi.advanceTimersByTimeAsync(15_000);
            await rejected;
            await expect(termination).resolves.toBe('disconnected');
            // The phone's own verdict reaches the Server log only through this private close code.
            expect(socket?.closeCodes.at(-1)).toBe(mobileClientCloseReasons['request-timeout']);
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
            paired.connection.close('unmounted');
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
                    attentionGeneration: 1,
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
            paired.connection.close('unmounted');
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
                projects: [{ id: 'project-1', title: 'Fixture' }],
            },
        );
        paired.connection.close('unmounted');
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
        paired.connection.close('unmounted');
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
        paired.connection.close('unmounted');
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
        paired.connection.close('unmounted');
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
            paired.connection.close('unmounted');
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
            paired.connection.close('unmounted');
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
            paired.connection.close('unmounted');
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

    it('tells the Server its route grace and socket open time in the reconnect hello', async () => {
        const hellos: unknown[] = [];
        const runtime: MobileGatewayRuntime = {
            isCellular: () => Promise.resolve(true),
            openWebSocket: () => {
                const socket = new UnverifiedReconnectSocket();
                const send = socket.send.bind(socket);
                socket.send = (source: string) => {
                    hellos.push(JSON.parse(source));
                    send(source);
                };
                return socket as unknown as WebSocket;
            },
            platform: 'android',
            randomBytes: (bytes) => new Uint8Array(bytes).fill(128),
        };
        const { store } = memoryStore();
        await expect(reconnectMobileGateway(mobileCredential, runtime, store)).rejects.toThrow();
        expect(hellos).toEqual([
            expect.objectContaining({
                mode: 'connect',
                trace: {
                    graceMs: SHORT_DIRECT_ROUTE_GRACE_MS,
                    openMs: expect.any(Number) as number,
                },
            }),
        ]);
    });

    it('sends a request right behind the reconnect confirmation and saves the route only on ready', async () => {
        const { runtime, saved, socket } = reconnectThrough();
        const { store } = memoryStore();
        const connection = await reconnectMobileGateway(mobileCredential, runtime, store);
        const reply = connection.request('project.query', { mode: 'list' });
        await flushTasks();
        expect(socket().received).toEqual(['confirm', 'request']);
        expect(saved).toEqual([]);

        socket().sendReady();
        await expect(reply).resolves.toEqual(expect.objectContaining({ view: 'paired-device' }));
        expect(saved).toEqual(['direct']);
        connection.close('unmounted');
    });

    it('ends a reconnect whose ready names another device identity', async () => {
        const { runtime, saved, socket } = reconnectThrough({ generation: 2 });
        const { store } = memoryStore();
        await store.save(mobileCredential);
        const connection = await reconnectMobileGateway(mobileCredential, runtime, store);
        const termination = new Promise((resolve) => connection.onTermination(resolve));
        socket().sendReady();

        await expect(termination).resolves.toBe('disconnected');
        expect(socket().closeCodes).toEqual([mobileClientCloseReasons['protocol-error']]);
        expect(saved).toEqual([]);
        await expect(store.load()).resolves.toEqual(mobileCredential);
    });

    it('ends a reconnect the Server never confirms with ready', async () => {
        vi.useFakeTimers();
        try {
            const { runtime, saved, socket } = reconnectThrough('never');
            const { store } = memoryStore();
            const connection = await reconnectMobileGateway(mobileCredential, runtime, store);
            const termination = new Promise((resolve) => connection.onTermination(resolve));
            await vi.runOnlyPendingTimersAsync();

            await expect(termination).resolves.toBe('disconnected');
            expect(socket().closeCodes).toEqual([mobileClientCloseReasons['ready-timeout']]);
            expect(saved).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

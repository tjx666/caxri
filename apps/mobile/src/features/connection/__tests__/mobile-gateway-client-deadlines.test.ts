import { describe, expect, it, vi } from 'vitest';

import type { MobileGatewayRuntime } from '../mobile-gateway-client';
import { pairMobileGateway } from '../mobile-gateway-client';
import type { MobileGatewayConnection } from '../mobile-gateway-connection';
import {
    FakeGatewaySocket,
    memoryStore,
    observeSettlement,
    pairingLink,
} from './mobile-gateway-fixture';

describe('mobile gateway deadlines', () => {
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
    ])(
        'times out an idempotent %s read after three seconds and keeps the connection',
        async (_name, request) => {
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
            let isTerminated = false;
            paired.connection.onTermination(() => {
                isTerminated = true;
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
                expect(isTerminated).toBe(false);
            } finally {
                paired.connection.close('unmounted');
                vi.useRealTimers();
            }
        },
    );

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

    it('rejects a late foreground probe without ending the connection', async () => {
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
        let isTerminated = false;
        paired.connection.onTermination(() => {
            isTerminated = true;
        });
        vi.useFakeTimers();
        try {
            const probe = paired.connection.probe();
            const rejected = expect(probe).rejects.toThrow(
                'Caxri did not respond to the foreground probe.',
            );
            await vi.advanceTimersByTimeAsync(1_500);
            await rejected;
            // A late answer only means a slow computer; the owner dials a replacement and lets the heartbeat judge this one.
            expect(isTerminated).toBe(false);
            expect(socket?.closeCodes).toEqual([]);
        } finally {
            paired.connection.close('unmounted');
            vi.useRealTimers();
        }
    });

    it('ends the connection when a subscription acknowledgement misses its deadline', async () => {
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
        let isTerminated = false;
        paired.connection.onTermination(() => {
            isTerminated = true;
        });
        vi.useFakeTimers();
        try {
            const subscription = paired.connection.subscribe({ kind: 'dashboard' }, vi.fn());
            const rejected = expect(subscription).rejects.toThrow();
            await vi.advanceTimersByTimeAsync(3_000);
            await rejected;
            // The Server may hold a subscription this client can no longer route, so the connection starts over.
            expect(isTerminated).toBe(true);
        } finally {
            paired.connection.close('unmounted');
            vi.useRealTimers();
        }
    });
});

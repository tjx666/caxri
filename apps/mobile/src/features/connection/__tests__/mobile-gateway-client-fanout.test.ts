import { describe, expect, it, vi } from 'vitest';

import type { MobileGatewayRuntime } from '../mobile-gateway-client';
import { pairMobileGateway } from '../mobile-gateway-client';
import { FakeGatewaySocket, memoryStore, pairingLink } from './mobile-gateway-fixture';

/**
 * Split from `mobile-gateway-client.test.ts` (rather than growing it past the repository's 800-line file ceiling)
 * because these two regressions for caxri#1441 need their own connection setup and do not share state with that file's
 * suite.
 */
describe('mobile gateway client fan-out isolation', () => {
    it('notifies a later onObservation listener when an earlier one throws', async () => {
        let randomByte = 128;
        const runtime: MobileGatewayRuntime = {
            openWebSocket: () => new FakeGatewaySocket() as unknown as WebSocket,
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
        const failing = vi.fn(() => {
            throw new Error('onObservation listener failure');
        });
        const surviving = vi.fn();
        paired.connection.onObservation(failing);
        paired.connection.onObservation(surviving);

        await paired.connection.request('project.query', { mode: 'list' });

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        paired.connection.close();
    });

    it('notifies a later onTermination listener when an earlier one throws', async () => {
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
        const failing = vi.fn(() => {
            throw new Error('onTermination listener failure');
        });
        const surviving = vi.fn();
        paired.connection.onTermination(failing);
        paired.connection.onTermination(surviving);
        vi.useFakeTimers();
        try {
            const first = paired.connection.request('project.query', { mode: 'list' });
            const firstRejected = expect(first).rejects.toThrow('Caxri did not respond in time.');
            await vi.advanceTimersByTimeAsync(1_000);
            const second = paired.connection.request('project.query', { mode: 'list' });
            await vi.advanceTimersByTimeAsync(14_000);
            await firstRejected;
            socket.sendHeartbeatAck();
            await Promise.resolve();
            const retry = paired.connection.request('project.query', { mode: 'list' });
            const retryRejected = expect(retry).rejects.toThrow('Caxri did not respond in time.');
            socket.releaseHeldRequestAt(1);
            await expect(second).resolves.toMatchObject({ view: 'paired-device' });
            await retryRejected;

            expect(failing).toHaveBeenCalledExactlyOnceWith('disconnected');
            expect(surviving).toHaveBeenCalledExactlyOnceWith('disconnected');
        } finally {
            paired.connection.close();
            vi.useRealTimers();
        }
    });
});

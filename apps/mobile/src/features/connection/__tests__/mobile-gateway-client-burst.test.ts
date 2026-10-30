import { describe, expect, it } from 'vitest';

import type { MobileGatewayRuntime } from '../mobile-gateway-client';
import { pairMobileGateway } from '../mobile-gateway-client';
import { FakeGatewaySocket, flushTasks, memoryStore, pairingLink } from './mobile-gateway-fixture';

const pairHeld = async () => {
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
    return { paired, socket };
};

describe('mobile gateway client inbound bursts', () => {
    it('keeps the connection when pipelined replies arrive before the reader resumes', async () => {
        const { paired, socket } = await pairHeld();
        // Opening a Session pipelines its subscriptions and reads; over the Relay their replies land back to back.
        const requests = Array.from({ length: 12 }, () =>
            paired.connection.request('project.query', { mode: 'list' }),
        );
        await flushTasks();
        socket.releaseHeldRequests();

        await expect(Promise.all(requests)).resolves.toHaveLength(12);
        expect(socket.closeCodes).toEqual([]);
        paired.connection.close('unmounted');
    });
});

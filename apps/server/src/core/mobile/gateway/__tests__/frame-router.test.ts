import type { Principal } from '@caxri/protocol';
import { createCommandDispatcher } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MobileGatewayFrameRouter } from '../frame-router';

const principal: Principal = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'view',
    projectIds: ['project-1'],
};

afterEach(() => vi.useRealTimers());

describe('MobileGatewayFrameRouter heartbeat', () => {
    it('acknowledges a foreground probe and closes an idle authenticated socket', async () => {
        vi.useFakeTimers();
        const send = vi.fn(async () => {});
        const terminate = vi.fn();
        const app = new MobileGatewayFrameRouter({
            authorizeMethod: () => {},
            authorizeSubscription: () => Promise.resolve(),
            context: () => ({
                capabilities: [],
                principal,
                connection: {
                    serverId: 'server-1',
                    bootId: 'boot-1',
                    stateEpoch: 'epoch-1',
                    clientId: 'mobile:device-1',
                    connectionId: 'connection-1',
                },
            }),
            dispatch: createCommandDispatcher({
                server: {
                    invoke: () => {
                        throw new Error('Unexpected command');
                    },
                },
            }),
            isActive: () => true,
            matchesSubscriptionEvent: () => Promise.resolve(true),
            now: () => Date.now(),
            randomSubscriptionId: () => 'subscription-1',
            send,
            terminate,
        });
        try {
            vi.advanceTimersByTime(9_000);
            app.accept({ type: 'heartbeat', nonce: 'ab'.repeat(16) });
            await Promise.resolve();
            expect(send).toHaveBeenCalledWith({
                type: 'heartbeat-ack',
                nonce: 'ab'.repeat(16),
            });
            vi.advanceTimersByTime(9_000);
            expect(terminate).not.toHaveBeenCalled();
            vi.advanceTimersByTime(3_000);
            expect(terminate).toHaveBeenCalledOnce();
        } finally {
            app.close();
        }
    });
});

import type { MobileServerPayload } from '@caxri/mobile-transport';
// oxlint-disable typescript/require-await -- Async Host and authorization fakes preserve the production Promise boundary.
import type { Principal } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { MobileGatewaySubscriptions } from '../subscriptions';

const principal: Principal = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-1'],
};

describe('MobileGatewaySubscriptions device actions', () => {
    it('delivers a device action only once the deviceActions subscription is acknowledged', async () => {
        const sent: MobileServerPayload[] = [];
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => 'device-actions-subscription',
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
        });
        const request = {
            actionId: `action_${'0'.repeat(32)}`,
            action: { kind: 'openUrl' as const, url: 'https://example.com' },
        };
        expect(subscriptions.acceptsDeviceActions()).toBe(false);
        expect(subscriptions.deliverDeviceAction(request)).toBe(false);
        const id = await subscriptions.subscribe({ kind: 'deviceActions' });
        expect(subscriptions.acceptsDeviceActions()).toBe(false);
        subscriptions.activate(id);
        expect(subscriptions.acceptsDeviceActions()).toBe(true);
        expect(subscriptions.deliverDeviceAction(request)).toBe(true);
        await vi.waitFor(() =>
            expect(sent).toEqual([
                {
                    type: 'event',
                    subscriptionId: id,
                    sequence: 0,
                    kind: 'deviceAction.requested',
                    request,
                },
            ]),
        );
        subscriptions.unsubscribe(id);
        expect(subscriptions.acceptsDeviceActions()).toBe(false);
        subscriptions.close();
    });
});

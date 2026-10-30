import { describe, expect, it, vi } from 'vitest';

import type {
    MobileGatewayConnection,
    MobileGatewaySubscriptionHandle,
} from '../mobile-gateway-connection';
import { acquireMobileSubscription } from '../use-mobile-client-controller';

vi.mock('react-native', () => ({ AppState: { currentState: 'active' } }));
vi.mock('expo-device', () => ({ modelName: 'Fixture device' }));
vi.mock('expo-network', () => ({ addNetworkStateListener: vi.fn() }));
vi.mock('../expo-credential-store', () => ({ expoMobileCredentialStore: {} }));
vi.mock('../expo-mobile-gateway-runtime', () => ({ expoMobileGatewayRuntime: {} }));

describe('mobile subscription ownership', () => {
    it('returns a subscription handle while its connection remains current', async () => {
        const unsubscribe = vi.fn(() => Promise.resolve());
        const handle: MobileGatewaySubscriptionHandle = {
            subscriptionId: 'subscription-1',
            unsubscribe,
        };
        const subscribe = vi.fn(() => Promise.resolve(handle));
        const connection = { subscribe } as unknown as MobileGatewayConnection;
        const listener = vi.fn();

        await expect(
            acquireMobileSubscription({
                connection,
                currentConnection: () => connection,
                listener,
                resource: { kind: 'dashboard' },
            }),
        ).resolves.toBe(handle);
        expect(subscribe).toHaveBeenCalledExactlyOnceWith({ kind: 'dashboard' }, listener);
        expect(unsubscribe).not.toHaveBeenCalled();
    });

    it('releases a handle whose connection changed before the subscribe ACK', async () => {
        const unsubscribe = vi.fn(() => Promise.resolve());
        const handle: MobileGatewaySubscriptionHandle = {
            subscriptionId: 'subscription-1',
            unsubscribe,
        };
        const { promise, resolve } = Promise.withResolvers<MobileGatewaySubscriptionHandle>();
        const subscribe = vi.fn(() => promise);
        const connection = { subscribe } as unknown as MobileGatewayConnection;
        let currentConnection: MobileGatewayConnection | null = connection;
        const pending = acquireMobileSubscription({
            connection,
            currentConnection: () => currentConnection,
            listener: vi.fn(),
            resource: { kind: 'dashboard' },
        });
        const rejected = expect(pending).rejects.toThrow('Caxri is reconnecting.');
        expect(subscribe).toHaveBeenCalledOnce();
        currentConnection = null;
        resolve(handle);
        await rejected;
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
});

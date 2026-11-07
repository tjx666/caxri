import { describe, expect, it, vi } from 'vitest';

import type { MobileGatewayRoute } from '../gateway-routes';
import {
    createMobileRoutePreferenceStore,
    isRouteAllowedByPreference,
    routesForPreference,
} from '../route-preference';

const direct: MobileGatewayRoute = { kind: 'direct', address: '192.168.1.5', port: 41_337 };
const tailnet: MobileGatewayRoute = { kind: 'direct', address: '100.64.0.2', port: 41_337 };
const relay: MobileGatewayRoute = {
    kind: 'relay',
    url: 'wss://relay.example.com',
    hostId: 'cd'.repeat(16),
    accessKey: new Uint8Array(32),
};

describe('routesForPreference', () => {
    it('races every route when automatic', () => {
        expect(routesForPreference([direct, tailnet, relay], 'auto')).toEqual([
            direct,
            tailnet,
            relay,
        ]);
    });

    it('keeps only the pinned path', () => {
        expect(routesForPreference([direct, tailnet, relay], 'direct')).toEqual([direct, tailnet]);
        expect(routesForPreference([direct, tailnet, relay], 'relay')).toEqual([relay]);
    });

    it('falls back to every route when the pairing does not offer the pinned path', () => {
        expect(routesForPreference([direct], 'relay')).toEqual([direct]);
    });
});

describe('isRouteAllowedByPreference', () => {
    it('accepts any path when automatic and only the pinned one otherwise', () => {
        expect(isRouteAllowedByPreference('relay', 'auto')).toBe(true);
        expect(isRouteAllowedByPreference('direct', 'direct')).toBe(true);
        expect(isRouteAllowedByPreference('relay', 'direct')).toBe(false);
        expect(isRouteAllowedByPreference('direct', 'relay')).toBe(false);
    });
});

describe('createMobileRoutePreferenceStore', () => {
    const memoryStorage = (initial?: string) => {
        const values = new Map<string, string>();
        if (initial !== undefined) values.set('caxri.mobile-route-preference.v1', initial);
        return {
            values,
            getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
            setItemAsync: vi.fn((key: string, value: string) => {
                values.set(key, value);
                return Promise.resolve();
            }),
        };
    };

    it('reads automatic when nothing, garbage, or an unreadable store is there', async () => {
        await expect(createMobileRoutePreferenceStore(memoryStorage()).load()).resolves.toBe(
            'auto',
        );
        await expect(
            createMobileRoutePreferenceStore(memoryStorage('sideways')).load(),
        ).resolves.toBe('auto');
        await expect(
            createMobileRoutePreferenceStore({
                getItemAsync: () => Promise.reject(new Error('locked')),
                setItemAsync: () => Promise.resolve(),
            }).load(),
        ).resolves.toBe('auto');
    });

    it('persists a choice across store instances', async () => {
        const storage = memoryStorage();
        await createMobileRoutePreferenceStore(storage).save('relay');
        await expect(createMobileRoutePreferenceStore(storage).load()).resolves.toBe('relay');
    });
});

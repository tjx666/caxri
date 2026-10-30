import { describe, expect, it, vi } from 'vitest';

import {
    DIRECT_ROUTE_GRACE_MS,
    directRouteGraceFor,
    SHORT_DIRECT_ROUTE_GRACE_MS,
} from '../gateway-routes';
import { createMobileRouteHints } from '../route-hints';

const memoryStorage = (initial?: string) => {
    const values = new Map<string, string>();
    if (initial !== undefined) values.set('caxri.mobile-route-hint.v1', initial);
    return {
        values,
        getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
        setItemAsync: vi.fn((key: string, value: string) => {
            values.set(key, value);
            return Promise.resolve();
        }),
    };
};

describe('direct route grace', () => {
    const home = ['192.168.1.20'];

    it('keeps the full head start for a phone that last connected directly on Wi-Fi', () => {
        expect(
            directRouteGraceFor({ addresses: home, isCellular: false, lastRoute: 'direct' }),
        ).toBe(DIRECT_ROUTE_GRACE_MS);
        expect(
            directRouteGraceFor({ addresses: home, isCellular: false, lastRoute: undefined }),
        ).toBe(DIRECT_ROUTE_GRACE_MS);
    });

    it('shortens it when the Relay won last time or cellular data cannot reach a LAN address', () => {
        expect(
            directRouteGraceFor({ addresses: home, isCellular: false, lastRoute: 'relay' }),
        ).toBe(SHORT_DIRECT_ROUTE_GRACE_MS);
        expect(
            directRouteGraceFor({ addresses: home, isCellular: true, lastRoute: undefined }),
        ).toBe(SHORT_DIRECT_ROUTE_GRACE_MS);
    });

    it('keeps the full head start on cellular when a tailnet address can still answer', () => {
        expect(
            directRouteGraceFor({
                addresses: ['192.168.1.20', '100.101.102.103'],
                isCellular: true,
                lastRoute: 'direct',
            }),
        ).toBe(DIRECT_ROUTE_GRACE_MS);
    });
});

describe('route hints', () => {
    it('remembers the winning route per computer across a process restart', async () => {
        const storage = memoryStorage();
        createMobileRouteHints(storage).save('server-1', 'relay');
        await vi.waitFor(() => expect(storage.setItemAsync).toHaveBeenCalledOnce());
        const restarted = createMobileRouteHints(storage);
        await expect(restarted.load('server-1')).resolves.toBe('relay');
        await expect(restarted.load('server-2')).resolves.toBeUndefined();
    });

    it('writes only when the route changes', () => {
        const storage = memoryStorage();
        const hints = createMobileRouteHints(storage);
        hints.save('server-1', 'relay');
        hints.save('server-1', 'relay');
        hints.save('server-1', 'direct');
        expect(storage.setItemAsync).toHaveBeenCalledTimes(2);
    });

    it('treats an unreadable or malformed hint as unknown', async () => {
        await expect(
            createMobileRouteHints(memoryStorage('{"serverId":"server-1","route":"carrier"}')).load(
                'server-1',
            ),
        ).resolves.toBeUndefined();
        await expect(
            createMobileRouteHints({
                getItemAsync: () => Promise.reject(new Error('locked')),
                setItemAsync: () => Promise.resolve(),
            }).load('server-1'),
        ).resolves.toBeUndefined();
    });
});

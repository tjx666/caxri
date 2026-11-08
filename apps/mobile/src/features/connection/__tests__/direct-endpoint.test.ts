import { describe, expect, it, vi } from 'vitest';

import {
    createMobileDirectEndpoints,
    refreshDirectEndpoint,
    resolveDirectEndpoint,
    sanitizeDirectEndpoint,
} from '../direct-endpoint';

const memoryStorage = (initial?: string) => {
    const values = new Map<string, string>();
    if (initial !== undefined) values.set('caxri.mobile-direct-endpoint.v1', initial);
    return {
        values,
        getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
        setItemAsync: vi.fn((key: string, value: string) => {
            values.set(key, value);
            return Promise.resolve();
        }),
    };
};

const paired = { addresses: ['192.168.1.5'], port: 4100, serverId: 'server-a' };

describe('direct endpoint', () => {
    it('keeps only unique private IPv4 addresses and a valid port', () => {
        expect(
            sanitizeDirectEndpoint({
                addresses: ['192.168.5.5', '8.8.8.8', '192.168.5.5', 'nope', 7, '100.101.1.2'],
                port: 4100,
            }),
        ).toEqual({ addresses: ['192.168.5.5', '100.101.1.2'], port: 4100 });
        expect(sanitizeDirectEndpoint({ addresses: ['8.8.8.8'], port: 4100 })).toBeUndefined();
        expect(sanitizeDirectEndpoint({ addresses: ['10.0.0.2'], port: 0 })).toBeUndefined();
        expect(sanitizeDirectEndpoint(null)).toBeUndefined();
    });

    it('dials the paired addresses until the computer reports newer ones', async () => {
        const endpoints = createMobileDirectEndpoints(memoryStorage());
        await expect(resolveDirectEndpoint(paired, endpoints)).resolves.toEqual({
            addresses: ['192.168.1.5'],
            port: 4100,
        });

        await refreshDirectEndpoint({
            endpoints,
            read: () => Promise.resolve({ addresses: ['192.168.5.5'], port: 4100 }),
            serverId: 'server-a',
        });
        await expect(resolveDirectEndpoint(paired, endpoints)).resolves.toEqual({
            addresses: ['192.168.5.5'],
            port: 4100,
        });
        await expect(
            resolveDirectEndpoint({ ...paired, serverId: 'server-b' }, endpoints),
        ).resolves.toEqual({ addresses: ['192.168.1.5'], port: 4100 });
    });

    it('keeps the stored endpoint when the computer cannot answer', async () => {
        const endpoints = createMobileDirectEndpoints(memoryStorage());
        endpoints.save('server-a', { addresses: ['192.168.5.5'], port: 4100 });
        await refreshDirectEndpoint({
            endpoints,
            read: () => Promise.reject(new Error('METHOD_NOT_FOUND')),
            serverId: 'server-a',
        });
        await refreshDirectEndpoint({
            endpoints,
            read: () => Promise.resolve({ addresses: ['8.8.8.8'], port: 4100 }),
            serverId: 'server-a',
        });
        await expect(endpoints.load('server-a')).resolves.toEqual({
            addresses: ['192.168.5.5'],
            port: 4100,
        });
    });

    it('survives an app restart through storage and ignores a corrupt record', async () => {
        const storage = memoryStorage();
        createMobileDirectEndpoints(storage).save('server-a', {
            addresses: ['192.168.5.5'],
            port: 4100,
        });
        await expect(createMobileDirectEndpoints(storage).load('server-a')).resolves.toEqual({
            addresses: ['192.168.5.5'],
            port: 4100,
        });
        await expect(
            createMobileDirectEndpoints(memoryStorage('{not json')).load('server-a'),
        ).resolves.toBeUndefined();
    });
});

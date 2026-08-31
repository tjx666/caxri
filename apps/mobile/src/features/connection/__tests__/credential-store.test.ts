import { describe, expect, it } from 'vitest';

import type { CredentialStorageAdapter, MobileCredential } from '../credential-store';
import { createMobileCredentialStore } from '../credential-store';

const credential = {
    version: 1,
    addresses: ['192.168.1.5'],
    port: 42_131,
    serverId: 'server-1',
    deviceId: `device_${'01'.repeat(16)}`,
    generation: 1,
    credential: 'ab'.repeat(32),
} satisfies MobileCredential;

const memoryStorage = (): CredentialStorageAdapter & { values: Map<string, string> } => {
    const values = new Map<string, string>();
    return {
        values,
        deleteItemAsync: (key) => {
            values.delete(key);
            return Promise.resolve();
        },
        getItemAsync: (key) => Promise.resolve(values.get(key) ?? null),
        setItemAsync: (key, value) => {
            values.set(key, value);
            return Promise.resolve();
        },
    };
};

describe('mobile credential store', () => {
    it('round-trips the bounded device credential', async () => {
        const storage = memoryStorage();
        const store = createMobileCredentialStore(storage);

        await store.save(credential);

        await expect(store.load()).resolves.toEqual(credential);
        const serialized = storage.values.values().toArray()[0];
        expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(512);
    });

    it('deletes invalid values instead of exposing them to reconnect', async () => {
        const storage = memoryStorage();
        storage.values.set('caxri.mobile-credential.v1', '{"credential":"secret"}');

        await expect(createMobileCredentialStore(storage).load()).resolves.toBeNull();
        expect(storage.values.size).toBe(0);
    });
});

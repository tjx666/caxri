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

const replacementCredential = {
    ...credential,
    generation: 2,
    credential: 'cd'.repeat(32),
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
    it('rolls back a pairing superseded during a native write before releasing the queue', async () => {
        const storage = memoryStorage();
        const store = createMobileCredentialStore(storage);
        await store.save(credential);
        let isCurrent = true;
        let releaseWrite = (): void => {};
        let reportWrite = (): void => {};
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- Match the mobile runtime target.
        const started = new Promise<void>((resolve) => {
            reportWrite = resolve;
        });
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- Match the mobile runtime target.
        const finish = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        const write = storage.setItemAsync.bind(storage);
        storage.setItemAsync = async (key, value) => {
            if (value === JSON.stringify(replacementCredential)) {
                reportWrite();
                await finish;
            }
            await write(key, value);
        };
        const save = store.save(replacementCredential, () => isCurrent);
        const rejected = expect(save).rejects.toThrow('superseded');
        await started;
        isCurrent = false;
        const snapshot = store.load();
        releaseWrite();
        await rejected;
        await expect(snapshot).resolves.toEqual(credential);
        await store.clear();
        await expect(store.save(replacementCredential, () => false)).rejects.toThrow('superseded');
        await expect(store.load()).resolves.toBeNull();
    });

    it('round-trips the bounded device credential', async () => {
        const storage = memoryStorage();
        const store = createMobileCredentialStore(storage);

        await store.save(credential);

        await expect(store.load()).resolves.toEqual(credential);
        const serialized = storage.values.values().toArray()[0];
        expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(512);
    });

    it('retains Tailscale endpoints but rejects a stored public endpoint', async () => {
        const storage = memoryStorage();
        const store = createMobileCredentialStore(storage);

        await store.save({ ...credential, addresses: ['100.64.0.1', '192.168.1.5'] });
        await expect(store.load()).resolves.toEqual({
            ...credential,
            addresses: ['100.64.0.1', '192.168.1.5'],
        });

        storage.values.set(
            'caxri.mobile-credential.v1',
            JSON.stringify({ ...credential, addresses: ['8.8.8.8'] }),
        );
        await expect(store.load()).resolves.toBeNull();
    });

    it('keeps the Relay route of a credential and still loads one paired without it', async () => {
        const storage = memoryStorage();
        const store = createMobileCredentialStore(storage);
        const relay = { url: 'wss://relay.example.com', hostId: 'cd'.repeat(16) };

        await store.save({ ...credential, relay });
        await expect(store.load()).resolves.toEqual({ ...credential, relay });

        storage.values.set('caxri.mobile-credential.v1', JSON.stringify(credential));
        await expect(store.load()).resolves.toEqual(credential);
    });

    it('fails closed on a stored Relay route that is not a WebSocket URL', async () => {
        const storage = memoryStorage();
        storage.values.set(
            'caxri.mobile-credential.v1',
            JSON.stringify({
                ...credential,
                relay: { url: 'https://relay.example.com', hostId: 'cd'.repeat(16) },
            }),
        );

        await expect(createMobileCredentialStore(storage).load()).resolves.toBeNull();
        expect(storage.values.size).toBe(0);
    });

    it('deletes invalid values instead of exposing them to reconnect', async () => {
        const storage = memoryStorage();
        storage.values.set('caxri.mobile-credential.v1', '{"credential":"secret"}');

        await expect(createMobileCredentialStore(storage).load()).resolves.toBeNull();
        expect(storage.values.size).toBe(0);
    });

    it('does not let stale revocation delete a newly saved credential', async () => {
        const storage = memoryStorage();
        const store = createMobileCredentialStore(storage);
        await store.save(credential);
        let releaseDelete = (): void => {};
        let reportDeleteStarted = (): void => {};
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The Mobile TypeScript target does not include the ES2024 API.
        const deleteStarted = new Promise<void>((resolve) => {
            reportDeleteStarted = resolve;
        });
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The Mobile TypeScript target does not include the ES2024 API.
        const deleteMayFinish = new Promise<void>((resolve) => {
            releaseDelete = resolve;
        });
        storage.deleteItemAsync = async (key) => {
            reportDeleteStarted();
            await deleteMayFinish;
            storage.values.delete(key);
        };

        const staleClear = store.clearIfCurrent(credential);
        await deleteStarted;
        const replacementSave = store.save(replacementCredential);
        releaseDelete();
        await Promise.all([staleClear, replacementSave]);

        await expect(store.load()).resolves.toEqual(replacementCredential);
    });
});

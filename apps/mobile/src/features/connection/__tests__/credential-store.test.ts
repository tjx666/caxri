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

    it('does not let an older credential clear a replacement with the same device identity', async () => {
        const storage = memoryStorage();
        const store = createMobileCredentialStore(storage);
        const sameIdentityReplacement = {
            ...credential,
            credential: 'cd'.repeat(32),
        } satisfies MobileCredential;
        await store.save(sameIdentityReplacement);

        await expect(store.clearIfCurrent(credential)).resolves.toBe(false);
        await expect(store.load()).resolves.toEqual(sameIdentityReplacement);
    });

    it('restores a pairing replacement only while it is still current', async () => {
        const storage = memoryStorage();
        const store = createMobileCredentialStore(storage);
        await store.save(credential);
        expect(await store.saveIfActive(replacementCredential, () => true)).toMatchObject({
            previous: credential,
            saved: true,
        });

        const newerCredential = {
            ...replacementCredential,
            generation: 3,
            credential: 'ef'.repeat(32),
        } satisfies MobileCredential;
        await store.save(newerCredential);

        await expect(store.restoreIfCurrent(replacementCredential, credential)).resolves.toBe(
            false,
        );
        await expect(store.load()).resolves.toEqual(newerCredential);
    });

    it('does not save a cancelled pairing when it is still queued', async () => {
        const storage = memoryStorage();
        const store = createMobileCredentialStore(storage);
        const controller = new AbortController();

        await expect(
            store.saveIfActive(replacementCredential, () => !controller.signal.aborted),
        ).resolves.toMatchObject({ saved: true });
        controller.abort();
        await expect(
            store.saveIfActive(credential, () => !controller.signal.aborted),
        ).resolves.toMatchObject({ saved: false });
        await expect(store.load()).resolves.toEqual(replacementCredential);
    });

    it('restores before a queued load can observe a cancelled write', async () => {
        const storage = memoryStorage();
        const store = createMobileCredentialStore(storage);
        await store.save(credential);
        const controller = new AbortController();
        let reportWriteStarted = (): void => {};
        let releaseWrite = (): void => {};
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The Mobile TypeScript target does not include the ES2024 API.
        const writeStarted = new Promise<void>((resolve) => {
            reportWriteStarted = resolve;
        });
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The Mobile TypeScript target does not include the ES2024 API.
        const writeMayFinish = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        storage.setItemAsync = async (key, value) => {
            reportWriteStarted();
            await writeMayFinish;
            storage.values.set(key, value);
        };

        const save = store.saveIfActive(replacementCredential, () => !controller.signal.aborted);
        await writeStarted;
        const queuedLoad = store.load();
        controller.abort();
        releaseWrite();

        await expect(save).resolves.toEqual({ previous: credential, saved: false });
        await expect(queuedLoad).resolves.toEqual(credential);
    });
});

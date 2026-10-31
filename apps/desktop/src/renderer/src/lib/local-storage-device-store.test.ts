import { createDeviceStore } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { localStorageDeviceStoreBackend } from './local-storage-device-store';

/**
 * The suite runs under Vitest's `node` environment, which has no `localStorage`; this stands in for the profile's.
 */
function stubStorage(
    entries = new Map<string, string>(),
    overrides: Partial<Pick<Storage, 'setItem'>> = {},
): Map<string, string> {
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => entries.get(key) ?? null,
        key: (index: number) => entries.keys().toArray()[index] ?? null,
        get length() {
            return entries.size;
        },
        removeItem: (key: string) => {
            entries.delete(key);
        },
        setItem: (key: string, value: string) => {
            entries.set(key, value);
        },
        ...overrides,
    });
    return entries;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('localStorageDeviceStoreBackend', () => {
    it('keeps entries under its own prefix, apart from other keys and other prefixes', () => {
        const entries = stubStorage(new Map([['caxri.unrelated', 'kept']]));
        const local = localStorageDeviceStoreBackend('composer:local:');
        const ssh = localStorageDeviceStoreBackend('composer:ssh:host:');
        local.write('draft:a', 'local text');
        ssh.write('draft:a', 'ssh text');

        expect(local.read('draft:a')).toBe('local text');
        expect(ssh.read('draft:a')).toBe('ssh text');
        expect(local.list().map(({ name, size }) => ({ name, size }))).toEqual([
            { name: 'draft:a', size: 10 },
        ]);
        expect(local.count()).toBe(1);

        local.clear();
        expect(local.read('draft:a')).toBeNull();
        expect(
            entries
                .keys()
                .toArray()
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['caxri.unrelated', 'composer:ssh:host:draft:a']);
    });

    it('treats a corrupt entry as missing', () => {
        stubStorage(new Map([['composer:local:draft:a', '{not json']]));
        const backend = localStorageDeviceStoreBackend('composer:local:');
        expect(backend.read('draft:a')).toBeNull();
        expect(backend.list()).toEqual([]);
    });

    it('has a flushed device store write on disk when the flush returns', () => {
        vi.useFakeTimers();
        stubStorage();
        const backend = localStorageDeviceStoreBackend('composer:local:');
        const store = createDeviceStore({ backend, version: 1, writeDelayMs: 300 });
        store.setScope('local');
        store.save('local', 'draft:a', 'typed right before the reload');
        expect(backend.read('draft:a')).toBeNull();

        void store.flush();
        expect(backend.read('draft:a')).toContain('typed right before the reload');
    });

    it('fails a write the quota refuses without throwing past the device store', () => {
        vi.useFakeTimers();
        stubStorage(new Map(), {
            setItem: () => {
                throw new DOMException('full', 'QuotaExceededError');
            },
        });
        const store = createDeviceStore({
            backend: localStorageDeviceStoreBackend('composer:local:'),
            version: 1,
            writeDelayMs: 0,
        });
        store.setScope('local');
        store.save('local', 'draft:a', 'text');
        expect(() => store.flush()).not.toThrow();
    });
});

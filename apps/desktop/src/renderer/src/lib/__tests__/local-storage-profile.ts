import { vi } from 'vitest';

/**
 * Stands in for one browser profile whose windows share a `localStorage`. The suites run under Vitest's `node`
 * environment, so `window` and `localStorage` are installed as stubs. Every "window" in a test is just another store
 * instance in the same process, so `fireStorageEvent` plays the part the browser plays: it notifies the listeners of
 * the other windows after one of them wrote a key. Call `vi.unstubAllGlobals()` in `afterEach`.
 */
export function installSharedProfile(entries = new Map<string, string>()) {
    const listeners = new Set<(event: StorageEvent) => void>();
    const storage = {
        getItem: (key: string) => entries.get(key) ?? null,
        removeItem: (key: string) => {
            entries.delete(key);
        },
        setItem: (key: string, value: string) => {
            entries.set(key, value);
        },
    };
    vi.stubGlobal('localStorage', storage);
    // The module under test calls the global `addEventListener`, which a Window provides; `window` only has to exist.
    vi.stubGlobal('window', {});
    vi.stubGlobal('addEventListener', (_type: string, listener: (event: StorageEvent) => void) =>
        listeners.add(listener),
    );
    vi.stubGlobal('removeEventListener', (_type: string, listener: (event: StorageEvent) => void) =>
        listeners.delete(listener),
    );
    return {
        entries,
        /**
         * Delivers the `storage` event another window's write to `key` would raise.
         */
        fireStorageEvent: (key: string | null) => {
            for (const listener of listeners)
                listener({ key, storageArea: storage } as unknown as StorageEvent);
        },
        listenerCount: () => listeners.size,
    };
}

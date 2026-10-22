import type { DeviceStoreBackend } from '@caxri/protocol';
import { createDeviceStore } from '@caxri/protocol';
import type { z } from 'zod';

import type { ReadCacheEntry, ReadCacheKey } from './read-cache-model';
import {
    isConversationCacheFile,
    READ_CACHE_MAX_CONVERSATIONS,
    READ_CACHE_VERSION,
    readCacheFileName,
} from './read-cache-model';

/**
 * The flat directory the cache lives in. Kept behind an interface so the policy runs in Vitest without a device.
 */
export type ReadCacheFiles = DeviceStoreBackend;

/**
 * Writes trail the live view by this much, so a streaming Chat costs one write per pause instead of one per patch.
 */
export const READ_CACHE_WRITE_DELAY_MS = 1_000;

/**
 * The phone's read cache on the shared device store: every failure reads as a miss and every write may be lost, so a
 * broken file never blocks the live view it stands in for. Scope fencing, debouncing, and `clear` ordering live in
 * `createDeviceStore`; this module names the files and bounds the Conversations and Chats.
 */
export const createReadCache = (files: ReadCacheFiles, now: () => number = Date.now) => {
    const store = createDeviceStore({
        backend: files,
        now,
        retention: { isBounded: isConversationCacheFile, maxEntries: READ_CACHE_MAX_CONVERSATIONS },
        version: READ_CACHE_VERSION,
        writeDelayMs: READ_CACHE_WRITE_DELAY_MS,
    });

    const load = <Value>(
        scope: string,
        key: ReadCacheKey,
        schema: z.ZodType<Value>,
    ): Promise<ReadCacheEntry<Value> | null> => store.load(scope, readCacheFileName(key), schema);

    /**
     * `scope` is the pairing `value` was read under, not whichever pairing is current when the caller gets to save it.
     */
    const save = (scope: string, key: ReadCacheKey, value: unknown): void => {
        store.save(scope, readCacheFileName(key), value);
    };

    /**
     * Writes everything still waiting, for an app moving to the background where timers may never fire.
     */
    const flush = (): void => {
        // eslint-disable-next-line no-void -- the Expo backend is synchronous, so the writes already ran
        void store.flush();
    };

    return { clear: store.clear, flush, load, save, setScope: store.setScope };
};

export type ReadCache = ReturnType<typeof createReadCache>;

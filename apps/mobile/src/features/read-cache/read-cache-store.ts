import type { z } from 'zod';

import type { ReadCacheEntry, ReadCacheKey } from './read-cache-model';
import {
    decodeReadCacheEntry,
    encodeReadCacheEntry,
    isConversationCacheFile,
    READ_CACHE_MAX_CONVERSATIONS,
    readCacheFileName,
} from './read-cache-model';

/**
 * The flat directory the cache lives in. Kept behind an interface so the policy runs in Vitest without a device.
 */
export interface ReadCacheFiles {
    clear(): void;
    list(): Array<{ modifiedAt: number; name: string }>;
    read(name: string): Promise<string | null>;
    remove(name: string): void;
    write(name: string, text: string): void;
}

/**
 * Writes trail the live view by this much, so a streaming Chat costs one write per pause instead of one per patch.
 */
export const READ_CACHE_WRITE_DELAY_MS = 1_000;

/**
 * A best-effort read cache: every failure reads as a miss and every write may be lost, so a broken file never blocks
 * the live view it stands in for.
 */
export const createReadCache = (files: ReadCacheFiles, now: () => number = Date.now) => {
    const pending = new Map<string, { flush: () => void; timer: ReturnType<typeof setTimeout> }>();
    /**
     * Bumped by `clear`, so a write scheduled before it cannot bring a forgotten pairing's content back.
     */
    let epoch = 0;

    const evict = (): void => {
        const conversations = files
            .list()
            .filter(({ name }) => isConversationCacheFile(name))
            // eslint-disable-next-line unicorn/no-array-sort -- The mobile Hermes target does not support ES2023 toSorted.
            .sort((left, right) => right.modifiedAt - left.modifiedAt);
        for (const { name } of conversations.slice(READ_CACHE_MAX_CONVERSATIONS))
            files.remove(name);
    };

    const load = async <Value>(
        scope: string,
        key: ReadCacheKey,
        schema: z.ZodType<Value>,
    ): Promise<ReadCacheEntry<Value> | null> => {
        try {
            const text = await files.read(readCacheFileName(key));
            return text === null ? null : decodeReadCacheEntry(text, scope, schema);
        } catch {
            return null;
        }
    };

    const save = (scope: string, key: ReadCacheKey, value: unknown): void => {
        const name = readCacheFileName(key);
        const previous = pending.get(name);
        if (previous) clearTimeout(previous.timer);
        const scheduledEpoch = epoch;
        const flush = (): void => {
            pending.delete(name);
            if (scheduledEpoch !== epoch) return;
            try {
                files.write(name, encodeReadCacheEntry(scope, now(), value));
                evict();
            } catch {
                // A full or read-only disk only costs the next cold start its saved copy.
            }
        };
        pending.set(name, { flush, timer: setTimeout(flush, READ_CACHE_WRITE_DELAY_MS) });
    };

    /**
     * Writes everything still waiting, for an app moving to the background where timers may never fire.
     */
    const flush = (): void => {
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.flush();
        }
    };

    const clear = (): void => {
        epoch += 1;
        for (const entry of pending.values()) clearTimeout(entry.timer);
        pending.clear();
        try {
            files.clear();
        } catch {
            // Nothing readable survives: every entry is bound to the pairing that was just forgotten.
        }
    };

    return { clear, flush, load, save };
};

export type ReadCache = ReturnType<typeof createReadCache>;

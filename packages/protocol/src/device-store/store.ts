/* eslint-disable unicorn/prefer-await, unicorn/prefer-then-catch, promise/no-callback-in-promise -- A backend may answer
   synchronously or with a promise, and a synchronous one must finish on the caller's tick (the phone's background flush
   runs right before the system may suspend the app). `await` always defers, so this module chains explicitly. */
import type { z } from 'zod';

import type { DeviceStoreEntry } from './envelope.js';
import { decodeDeviceStoreEntry, encodeDeviceStoreEntry } from './envelope.js';

/**
 * One flat namespace of named text entries on the client device: a directory on the phone, an IndexedDB object store in
 * the Desktop Renderer. Each method may answer synchronously or with a promise; the store keeps every mutation in call
 * order either way.
 */
export type DeviceStoreListing = Array<{
    modifiedAt: number;
    name: string;
    /**
     * Characters of the stored text. Only a retention bound by characters reads it; an absent size counts as zero.
     */
    size?: number;
}>;

export interface DeviceStoreBackend {
    clear(): Promise<void> | void;
    /**
     * How many entries exist in total, when the backend can tell without reading them. Eviction skips `list` while this
     * is within the retention bound, since `list` may read every entry in full (IndexedDB's `getAll`).
     */
    count?(): number | Promise<number>;
    /**
     * Every entry with the time it was last written, used only to pick the oldest for eviction.
     */
    list(): DeviceStoreListing | Promise<DeviceStoreListing>;
    read(name: string): Promise<string | null>;
    remove(name: string): Promise<void> | void;
    write(name: string, text: string): Promise<void> | void;
}

export interface DeviceStoreRetention {
    isBounded(name: string): boolean;
    maxCharacters?: number;
    maxEntries?: number;
}

export interface DeviceStoreOptions {
    backend: DeviceStoreBackend;
    /**
     * Format version of the values this store writes. An entry from another version reads as a miss.
     */
    version: number;
    /**
     * How long a save trails the change it records, so a stream of edits costs one write per pause.
     */
    writeDelayMs: number;
    /**
     * Bounds families of entries: after each write, entries a rule's `isBounded` accepts are kept newest first while
     * they fit `maxEntries` and `maxCharacters`, and the rest are removed. Entries no rule accepts are never evicted. A
     * single entry that alone exceeds `maxCharacters` is evicted whole rather than cut.
     */
    retention?: DeviceStoreRetention | readonly DeviceStoreRetention[];
    now?: () => number;
}

interface Pending {
    flush: () => void;
    timer: ReturnType<typeof setTimeout>;
}

const isPromise = (value: unknown): value is Promise<unknown> =>
    typeof (value as { then?: unknown } | undefined)?.then === 'function';

/**
 * Runs `next` after `first`, synchronously when `first` finished synchronously.
 */
const then = (first: () => unknown, next: () => unknown): unknown => {
    const result = first();
    return isPromise(result) ? result.then(next) : next();
};

/**
 * A best-effort store for what the client keeps on its own device while the Server may be out of reach: saved copies of
 * what the user last read, and backups of what the user typed but has not sent or saved.
 *
 * Every entry is bound to the scope it was read or typed under. A write flushes only while its scope is still the
 * active one, and `clear` fences out every write scheduled before it, so content from a forgotten pairing or another
 * Server never lands on disk under any label. Every failure reads as a miss: a broken entry never blocks the live
 * view.
 */
export const createDeviceStore = (options: DeviceStoreOptions) => {
    const { backend, version, writeDelayMs } = options;
    const { retention } = options;
    const rules: readonly DeviceStoreRetention[] = !retention
        ? []
        : 'isBounded' in retention
          ? [retention]
          : retention;
    const now = options.now ?? Date.now;
    const pending = new Map<string, Pending>();
    /**
     * Bumped by `clear`, so a write scheduled before it cannot bring forgotten content back.
     */
    let epoch = 0;
    let activeScope: string | null = null;
    /**
     * Mutations still running against an asynchronous backend. While it is zero a synchronous backend runs each
     * mutation inline, which keeps the phone's background flush on the same tick as the call that requested it.
     */
    let running = 0;
    let tail: Promise<void> = Promise.resolve();

    const settle = (): void => {
        running -= 1;
    };

    const run = (mutation: () => unknown): void => {
        if (running === 0) {
            let result: unknown;
            try {
                result = mutation();
            } catch {
                return;
            }
            if (!isPromise(result)) return;
            running += 1;
            tail = result.then(settle, settle);
            return;
        }
        running += 1;
        tail = tail.then(mutation).then(settle, settle);
    };

    /**
     * Name, last write time, and size of every entry, kept only when a rule bounds by characters: it is read from the
     * backend once, then follows this store's own mutations, so a write never re-reads other entries' text. Entries
     * another window of the same scope writes are unseen until the next launch, which only loosens a bound for a
     * while.
     */
    let ledger: Map<string, { modifiedAt: number; size: number }> | undefined;
    /**
     * Orders ledger entries by this store's own writes rather than a clock, since a seeded entry carries the backend's
     * clock and a new one this store's `now`.
     */
    let sequence = 0;

    const removeEntry = (name: string): unknown =>
        then(
            () => backend.remove(name),
            () => ledger?.delete(name),
        );

    /**
     * Removes the entries `rule` bounds beyond what fits, newest kept first, in order, synchronously while the backend
     * answers synchronously.
     */
    const evictFrom = (listed: DeviceStoreListing, rule: DeviceStoreRetention): unknown => {
        const bounded = listed
            .filter(({ name }) => rule.isBounded(name))
            // eslint-disable-next-line unicorn/no-array-sort -- The mobile Hermes target does not support ES2023 toSorted.
            .sort((left, right) => right.modifiedAt - left.modifiedAt);
        let characters = 0;
        let overflowFrom = bounded.length;
        for (const [index, { size }] of bounded.entries()) {
            characters += size ?? 0;
            if (
                (rule.maxEntries !== undefined && index >= rule.maxEntries) ||
                (rule.maxCharacters !== undefined && characters > rule.maxCharacters)
            ) {
                overflowFrom = index;
                break;
            }
        }
        // Removals stay ordered with the writes around them.
        let result: unknown;
        for (const { name } of bounded.slice(overflowFrom))
            result = isPromise(result) ? result.then(() => removeEntry(name)) : removeEntry(name);
        return result;
    };

    const ledgerListing = (): DeviceStoreListing =>
        [...(ledger ?? [])].map(([name, entry]) => ({ name, ...entry }));

    const withListing = (apply: (listed: DeviceStoreListing) => unknown): unknown => {
        if (ledger) return apply(ledgerListing());
        const seed = (listed: DeviceStoreListing): unknown => {
            const seeded = new Map<string, { modifiedAt: number; size: number }>();
            // Oldest first, so the sequence follows recency.
            // eslint-disable-next-line unicorn/no-array-sort -- The mobile Hermes target does not support ES2023 toSorted.
            const oldestFirst = [...listed].sort((l, r) => l.modifiedAt - r.modifiedAt);
            for (const entry of oldestFirst) {
                sequence += 1;
                seeded.set(entry.name, { modifiedAt: sequence, size: entry.size ?? 0 });
            }
            ledger = seeded;
            return apply(ledgerListing());
        };
        const listed = backend.list();
        return isPromise(listed) ? listed.then(seed) : seed(listed);
    };

    /**
     * Evicts for one rule after a write. A rule bounding only the entry count on a backend that counts is listed only
     * once the total exceeds the bound: its family is a subset of every entry, so a total within it cannot hold an
     * entry to evict.
     */
    const evictRule = (rule: DeviceStoreRetention): unknown => {
        if (rule.maxCharacters !== undefined)
            return withListing((listed) => evictFrom(listed, rule));
        const { maxEntries } = rule;
        if (maxEntries === undefined) return undefined;
        const listAndEvict = (): unknown => {
            const listed = backend.list();
            return isPromise(listed)
                ? listed.then((entries) => evictFrom(entries, rule))
                : evictFrom(listed, rule);
        };
        const counted = backend.count?.();
        if (counted === undefined) return listAndEvict();
        if (isPromise(counted))
            return counted.then((total) => (total > maxEntries ? listAndEvict() : undefined));
        return counted > maxEntries ? listAndEvict() : undefined;
    };

    const evictSync = (): unknown =>
        rules.reduce<() => unknown>(
            (previous, rule) => () => then(previous, () => evictRule(rule)),
            () => {},
        )();

    /**
     * Reads one entry written under `scope`. Waits for mutations still in flight, so a read never sees an entry its own
     * window already replaced or removed.
     */
    const load = async <Value>(
        scope: string,
        name: string,
        schema: z.ZodType<Value>,
    ): Promise<DeviceStoreEntry<Value> | null> => {
        try {
            if (running > 0) await tail;
            const text = await backend.read(name);
            return text === null ? null : decodeDeviceStoreEntry(text, version, scope, schema);
        } catch {
            return null;
        }
    };

    /**
     * Schedules `value` under `name`. `scope` is the identity the value was read or typed under, not whichever scope is
     * current when the caller gets to save it.
     */
    const save = (scope: string, name: string, value: unknown): void => {
        const previous = pending.get(name);
        if (previous) clearTimeout(previous.timer);
        const scheduledEpoch = epoch;
        const flush = (): void => {
            pending.delete(name);
            if (scheduledEpoch !== epoch || scope !== activeScope) return;
            run(() =>
                then(() => {
                    const text = encodeDeviceStoreEntry(version, scope, now(), value);
                    const written = backend.write(name, text);
                    return then(
                        () => written,
                        () => {
                            // Reinserted, so the map's order stays recency order.
                            if (!ledger) return;
                            ledger.delete(name);
                            sequence += 1;
                            ledger.set(name, { modifiedAt: sequence, size: text.length });
                        },
                    );
                }, evictSync),
            );
        };
        pending.set(name, { flush, timer: setTimeout(flush, writeDelayMs) });
    };

    /**
     * Drops one entry and any write still waiting for it, for content the user saved, sent, or discarded.
     */
    const remove = (name: string): void => {
        const previous = pending.get(name);
        if (previous) {
            clearTimeout(previous.timer);
            pending.delete(name);
        }
        run(() => removeEntry(name));
    };

    /**
     * Writes everything still waiting, for a window or app moving where timers may never fire. The promise settles once
     * those writes reach the backend; a synchronous backend has already finished when this returns.
     */
    const flush = (): Promise<void> => {
        for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.flush();
        }
        return running > 0 ? tail : Promise.resolve();
    };

    const clear = (): void => {
        epoch += 1;
        for (const entry of pending.values()) clearTimeout(entry.timer);
        pending.clear();
        run(() =>
            then(
                () => backend.clear(),
                () => {
                    ledger = undefined;
                },
            ),
        );
    };

    /**
     * Follows the identity the client currently reads under. `null` while it has none, so nothing is written without an
     * identity to bind it to.
     */
    const setScope = (scope: string | null): void => {
        activeScope = scope;
    };

    return { clear, flush, load, remove, save, setScope };
};
/* eslint-enable unicorn/prefer-await, unicorn/prefer-then-catch, promise/no-callback-in-promise */

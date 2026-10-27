import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { decodeDeviceStoreEntry, encodeDeviceStoreEntry } from '../envelope';
import type { DeviceStoreBackend } from '../store';
import { createDeviceStore } from '../store';

const scope = 'ssh:me@example.internal:22';
const valueSchema = z.object({ text: z.string() });

/**
 * An IndexedDB-like backend: every call resolves on a later microtask, and the log records the order calls landed in.
 */
const asyncBackend = () => {
    const entries = new Map<string, { modifiedAt: number; text: string }>();
    const log: string[] = [];
    let clock = 0;
    const later = <T>(work: () => T): Promise<T> =>
        new Promise((resolve) => {
            queueMicrotask(() => resolve(work()));
        });
    const backend: DeviceStoreBackend = {
        clear: () =>
            later(() => {
                log.push('clear');
                entries.clear();
            }),
        list: () =>
            later(() =>
                [...entries].map(([name, entry]) => ({ name, modifiedAt: entry.modifiedAt })),
            ),
        read: (name) => later(() => entries.get(name)?.text ?? null),
        remove: (name) =>
            later(() => {
                log.push(`remove ${name}`);
                entries.delete(name);
            }),
        write: (name, text) =>
            later(() => {
                clock += 1;
                log.push(`write ${name}`);
                entries.set(name, { modifiedAt: clock, text });
            }),
    };
    return { backend, entries, log };
};

const createStore = (backend: DeviceStoreBackend, maxEntries = 2) =>
    createDeviceStore({
        backend,
        now: () => 7,
        retention: { isBounded: (name) => name.startsWith('backup-'), maxEntries },
        version: 3,
        writeDelayMs: 1_000,
    });

describe('device store envelope', () => {
    it('reads back only its own version and scope', () => {
        const text = encodeDeviceStoreEntry(3, scope, 7, { text: 'a' });
        expect(decodeDeviceStoreEntry(text, 3, scope, valueSchema)).toEqual({
            savedAt: 7,
            value: { text: 'a' },
        });
        expect(decodeDeviceStoreEntry(text, 2, scope, valueSchema)).toBeNull();
        expect(decodeDeviceStoreEntry(text, 3, 'local', valueSchema)).toBeNull();
        expect(decodeDeviceStoreEntry('{', 3, scope, valueSchema)).toBeNull();
        expect(
            decodeDeviceStoreEntry(
                encodeDeviceStoreEntry(3, scope, 7, { text: 1 }),
                3,
                scope,
                valueSchema,
            ),
        ).toBeNull();
    });
});

describe('device store over an asynchronous backend', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('writes once per pause and a read waits for the write in flight', async () => {
        const { backend, log } = asyncBackend();
        const store = createStore(backend);
        store.setScope(scope);
        store.save(scope, 'backup-a', { text: 'one' });
        store.save(scope, 'backup-a', { text: 'two' });
        vi.advanceTimersByTime(1_000);
        await expect(store.load(scope, 'backup-a', valueSchema)).resolves.toEqual({
            savedAt: 7,
            value: { text: 'two' },
        });
        expect(log).toEqual(['write backup-a']);
    });

    it('lands a clear after the writes it follows, and drops writes scheduled before it', async () => {
        const { backend, entries, log } = asyncBackend();
        const store = createStore(backend);
        store.setScope(scope);
        store.save(scope, 'backup-a', { text: 'flushed' });
        // Starts the write; it completes on a later microtask, after `clear` was requested.
        const flushed = store.flush();
        store.save(scope, 'backup-b', { text: 'scheduled' });
        store.clear();
        vi.advanceTimersByTime(1_000);
        await flushed;
        await store.flush();
        expect(log).toEqual(['write backup-a', 'clear']);
        expect(entries.size).toBe(0);
    });

    it('removes an entry and cancels its pending write', async () => {
        const { backend, entries } = asyncBackend();
        const store = createStore(backend);
        store.setScope(scope);
        store.save(scope, 'backup-a', { text: 'kept' });
        await store.flush();
        store.save(scope, 'backup-a', { text: 'never written' });
        store.remove('backup-a');
        vi.advanceTimersByTime(1_000);
        await store.flush();
        expect(entries.has('backup-a')).toBe(false);
        await expect(store.load(scope, 'backup-a', valueSchema)).resolves.toBeNull();
    });

    it('evicts only the oldest bounded entries', async () => {
        const { backend, entries } = asyncBackend();
        const store = createStore(backend, 2);
        store.setScope(scope);
        store.save(scope, 'index', { text: 'unbounded' });
        await store.flush();
        for (const name of ['backup-1', 'backup-2', 'backup-3']) {
            store.save(scope, name, { text: name });
            // eslint-disable-next-line no-await-in-loop -- each write must land before the next is scheduled
            await store.flush();
        }
        expect(
            entries
                .keys()
                .toArray()
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['backup-2', 'backup-3', 'index']);
    });

    it('lists a counting backend only once its entries exceed the bound, and still evicts the oldest then', async () => {
        const { backend, entries } = asyncBackend();
        const list = vi.fn(() => backend.list());
        const counting: DeviceStoreBackend = {
            ...backend,
            count: () => Promise.resolve(entries.size),
            list,
        };
        const store = createStore(counting, 2);
        store.setScope(scope);
        for (const name of ['backup-1', 'backup-2']) {
            store.save(scope, name, { text: name });
            // eslint-disable-next-line no-await-in-loop -- each write must land before the next is scheduled
            await store.flush();
        }
        expect(list).not.toHaveBeenCalled();

        store.save(scope, 'backup-3', { text: 'backup-3' });
        await store.flush();
        expect(list).toHaveBeenCalledOnce();
        expect(
            entries
                .keys()
                .toArray()
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['backup-2', 'backup-3']);
    });

    it('never writes under a scope that stopped being current, or without one', async () => {
        const { backend, entries } = asyncBackend();
        const store = createStore(backend);
        store.save(scope, 'backup-a', { text: 'no scope yet' });
        await store.flush();
        store.setScope(scope);
        store.save(scope, 'backup-b', { text: 'old scope' });
        store.setScope('local');
        await store.flush();
        expect(entries.size).toBe(0);
    });

    it('treats a failing backend as a miss and keeps running later mutations', async () => {
        const { backend, entries } = asyncBackend();
        let failures = 1;
        const store = createStore({
            ...backend,
            read: () => Promise.reject(new Error('io')),
            write: (name, text) => {
                if (failures > 0) {
                    failures -= 1;
                    return Promise.reject(new Error('quota'));
                }
                return backend.write(name, text);
            },
        });
        store.setScope(scope);
        store.save(scope, 'backup-a', { text: 'lost' });
        await expect(store.flush()).resolves.toBeUndefined();
        store.save(scope, 'backup-b', { text: 'kept' });
        await store.flush();
        expect(entries.keys().toArray()).toEqual(['backup-b']);
        await expect(store.load(scope, 'backup-b', valueSchema)).resolves.toBeNull();
    });
});

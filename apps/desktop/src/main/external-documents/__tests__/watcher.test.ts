import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExternalDocumentWatcher } from '../watcher';

const PATHS: Record<string, string> = {
    guide: '/notes/guide.md',
    todo: '/notes/todo.md',
    other: '/elsewhere/other.md',
};

type DiskState = 'busy' | 'changed' | 'unchanged';

function setup(
    diskState = vi.fn((): Promise<DiskState> => Promise.resolve('changed')),
    unwatchable = new Set<string>(),
) {
    const listeners = new Map<string, (filename?: string) => void>();
    const failures = new Map<string, () => void>();
    const opened: string[] = [];
    const closed: string[] = [];
    const emitted: string[] = [];
    const watcher = createExternalDocumentWatcher({
        emit: (documentId) => emitted.push(documentId),
        diskState,
        pathOf: (documentId) => PATHS[documentId],
        settleMs: 100,
        watchDirectory: (directory, onChange, onError) => {
            opened.push(directory);
            if (unwatchable.has(directory)) throw new Error('ENOENT');
            listeners.set(directory, onChange);
            failures.set(directory, onError);
            return { close: () => closed.push(directory) };
        },
    });
    return { closed, diskState, emitted, failures, listeners, opened, watcher };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('createExternalDocumentWatcher', () => {
    it('watches each folder once and reports a changed document after the writes settle', async () => {
        const { emitted, listeners, watcher } = setup();
        watcher.setWatched(['guide', 'todo', 'other']);
        expect(listeners.keys().toArray()).toEqual(['/notes', '/elsewhere']);

        listeners.get('/notes')!('guide.md');
        listeners.get('/notes')!('guide.md');
        listeners.get('/notes')!('unrelated.txt');
        await vi.advanceTimersByTimeAsync(99);
        expect(emitted).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);

        expect(emitted).toEqual(['guide']);
    });

    it('stays quiet when the file still matches what Main last read or wrote', async () => {
        const { emitted, listeners, watcher } = setup(
            vi.fn((): Promise<DiskState> => Promise.resolve('unchanged')),
        );
        watcher.setWatched(['guide']);

        listeners.get('/notes')!('guide.md');
        await vi.advanceTimersByTimeAsync(100);

        expect(emitted).toEqual([]);
    });

    it('waits for a save in flight before deciding', async () => {
        const diskState = vi
            .fn<() => Promise<DiskState>>()
            .mockResolvedValueOnce('busy')
            .mockResolvedValueOnce('changed');
        const { emitted, listeners, watcher } = setup(diskState);
        watcher.setWatched(['guide']);

        listeners.get('/notes')!('guide.md');
        await vi.advanceTimersByTimeAsync(100);
        expect(emitted).toEqual([]);
        await vi.advanceTimersByTimeAsync(100);

        expect(emitted).toEqual(['guide']);
    });

    it('checks every document in a folder when the platform does not name the entry', async () => {
        const { emitted, listeners, watcher } = setup();
        watcher.setWatched(['guide', 'todo']);

        listeners.get('/notes')!();
        await vi.advanceTimersByTimeAsync(100);

        expect(emitted).toEqual(['guide', 'todo']);
    });

    it('stops watching a folder and drops pending checks once its documents close', async () => {
        const { closed, emitted, listeners, watcher } = setup();
        watcher.setWatched(['guide', 'other']);
        listeners.get('/notes')!('guide.md');

        watcher.setWatched(['other']);
        await vi.advanceTimersByTimeAsync(100);

        expect(closed).toEqual(['/notes']);
        expect(emitted).toEqual([]);
    });

    it('watches a folder afresh after its watch failed, as when it was removed and created again', () => {
        const { failures, opened, watcher } = setup();
        watcher.setWatched(['guide']);

        failures.get('/notes')!();
        watcher.setWatched(['guide', 'todo']);

        expect(opened).toEqual(['/notes', '/notes']);
    });

    /**
     * The Workbench re-sends its set only when the open documents change, so a folder removed and created again must be
     * re-watched by Main itself, or an open document never hears of another app's edits again.
     */
    it('re-watches a folder on its own after its watch ended and reports a later change', async () => {
        // The re-watch re-checks the document and finds it untouched; the later edit is a real change.
        const diskState = vi
            .fn<() => Promise<DiskState>>()
            .mockResolvedValueOnce('unchanged')
            .mockResolvedValue('changed');
        const { emitted, failures, listeners, opened, watcher } = setup(diskState);
        watcher.setWatched(['guide']);

        failures.get('/notes')!();
        await vi.advanceTimersByTimeAsync(999);
        expect(opened).toEqual(['/notes']);
        await vi.advanceTimersByTimeAsync(1);
        expect(opened).toEqual(['/notes', '/notes']);

        await vi.advanceTimersByTimeAsync(100);
        expect(emitted).toEqual([]);
        listeners.get('/notes')!('guide.md');
        await vi.advanceTimersByTimeAsync(100);
        expect(emitted).toEqual(['guide']);
    });

    it('reports a change made while the folder was unwatched once a retry watches it again', async () => {
        const unwatchable = new Set(['/notes']);
        const { emitted, listeners, opened, watcher } = setup(undefined, unwatchable);
        watcher.setWatched(['guide']);
        expect(opened).toEqual(['/notes']);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(opened).toEqual(['/notes', '/notes']);
        unwatchable.clear();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(opened).toEqual(['/notes', '/notes', '/notes']);
        await vi.advanceTimersByTimeAsync(100);
        expect(emitted).toEqual(['guide']);

        listeners.get('/notes')!('guide.md');
        await vi.advanceTimersByTimeAsync(100);
        expect(emitted).toEqual(['guide', 'guide']);
    });

    it('gives up after a bounded number of retries', async () => {
        const { opened, watcher } = setup(undefined, new Set(['/notes']));
        watcher.setWatched(['guide']);

        await vi.advanceTimersByTimeAsync(10 * 60_000);

        expect(opened).toEqual(['/notes', '/notes', '/notes', '/notes']);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops retrying a folder no open document needs', async () => {
        const { failures, opened, watcher } = setup();
        watcher.setWatched(['guide', 'other']);

        failures.get('/notes')!();
        watcher.setWatched(['other']);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(opened).toEqual(['/notes', '/elsewhere']);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops retrying on dispose', async () => {
        const { failures, opened, watcher } = setup();
        watcher.setWatched(['guide']);

        failures.get('/notes')!();
        watcher.dispose();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(opened).toEqual(['/notes']);
        expect(vi.getTimerCount()).toBe(0);
    });
});

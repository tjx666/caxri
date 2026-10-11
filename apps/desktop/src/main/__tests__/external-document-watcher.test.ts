import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createExternalDocumentWatcher } from '../external-document-watcher';

const PATHS: Record<string, string> = {
    guide: '/notes/guide.md',
    todo: '/notes/todo.md',
    other: '/elsewhere/other.md',
};

type DiskState = 'busy' | 'changed' | 'unchanged';

function setup(diskState = vi.fn((): Promise<DiskState> => Promise.resolve('changed'))) {
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
});

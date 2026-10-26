import type { BootstrapState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { createRecoveringSnapshotSource } from '../recovering-snapshot-source';
import {
    recordRenderCrash,
    RENDER_CRASH_LOOP_WINDOW_MS,
    takeSessionToSkip,
} from '../render-crash-recovery';

function memoryStorage() {
    const data = new Map<string, string>();
    return {
        getItem: (key: string) => data.get(key) ?? null,
        removeItem: (key: string) => {
            data.delete(key);
        },
        setItem: (key: string, value: string) => {
            data.set(key, value);
        },
    };
}

describe('render crash recovery decision', () => {
    it('keeps restoring the Session after a single crash', () => {
        const storage = memoryStorage();
        recordRenderCrash(storage, { now: 1000, sessionId: 'a' });
        expect(takeSessionToSkip(storage, 2000)).toBeUndefined();
    });

    it('skips the Session after a repeated crash inside the loop window', () => {
        const storage = memoryStorage();
        recordRenderCrash(storage, { now: 1000, sessionId: 'a' });
        recordRenderCrash(storage, { now: 3000, sessionId: 'a' });
        expect(takeSessionToSkip(storage, 4000)).toBe('a');
    });

    it('breaks a reload loop: each load reads the record before the next crash is recorded', () => {
        const storage = memoryStorage();
        recordRenderCrash(storage, { now: 1000, sessionId: 'a' });
        expect(takeSessionToSkip(storage, 2000)).toBeUndefined();
        recordRenderCrash(storage, { now: 2500, sessionId: 'a' });
        expect(takeSessionToSkip(storage, 3000)).toBe('a');
        expect(takeSessionToSkip(storage, 3000)).toBeUndefined();
    });

    it('does not count crashes of different Sessions or outside the window as a loop', () => {
        const storage = memoryStorage();
        recordRenderCrash(storage, { now: 1000, sessionId: 'a' });
        recordRenderCrash(storage, { now: 2000, sessionId: 'b' });
        expect(takeSessionToSkip(storage, 3000)).toBeUndefined();
        recordRenderCrash(storage, { now: 1000, sessionId: 'a' });
        recordRenderCrash(storage, { now: 1000 + RENDER_CRASH_LOOP_WINDOW_MS + 1, sessionId: 'a' });
        expect(takeSessionToSkip(storage, 1000 + RENDER_CRASH_LOOP_WINDOW_MS + 2)).toBeUndefined();
    });

    it('skips immediately when the user asked to reload without the Session', () => {
        const storage = memoryStorage();
        recordRenderCrash(storage, { now: 1000, sessionId: 'a', skipRequested: true });
        expect(takeSessionToSkip(storage, 2000)).toBe('a');
    });

    it('ignores a stale record and consumes it so the skip applies once', () => {
        const storage = memoryStorage();
        recordRenderCrash(storage, { now: 1000, sessionId: 'a', skipRequested: true });
        expect(takeSessionToSkip(storage, 1000 + RENDER_CRASH_LOOP_WINDOW_MS + 1)).toBeUndefined();
        recordRenderCrash(storage, { now: 1000, sessionId: 'a', skipRequested: true });
        expect(takeSessionToSkip(storage, 2000)).toBe('a');
        expect(takeSessionToSkip(storage, 2000)).toBeUndefined();
    });

    it('never skips when no Session was active', () => {
        const storage = memoryStorage();
        recordRenderCrash(storage, { now: 1000, skipRequested: true });
        expect(takeSessionToSkip(storage, 1500)).toBeUndefined();
    });
});

describe('recovering snapshot source', () => {
    function snapshot(selected: string | undefined): BootstrapState {
        return {
            selectedSessionId: selected,
            sessions: [{ id: 'a' }, { id: 'b' }, { id: 'c', archivedAt: 1 }],
        } as unknown as BootstrapState;
    }

    it('selects another Session before the Workbench can mount the crashing one', async () => {
        const storage = memoryStorage();
        recordRenderCrash(storage, { now: 1000, sessionId: 'a', skipRequested: true });
        let selected: string | undefined = 'a';
        const selections: string[] = [];
        const read = createRecoveringSnapshotSource({
            now: () => 2000,
            readSnapshot: () => Promise.resolve(snapshot(selected)),
            selectSession: (id) => {
                selections.push(id);
                selected = id;
                return Promise.resolve({});
            },
            storage,
        });
        expect((await read()).selectedSessionId).toBe('b');
        expect(selections).toEqual(['b']);
        expect((await read()).selectedSessionId).toBe('b');
        expect(selections).toEqual(['b']);
    });

    it('falls back to the plain snapshot when the only other choice is owned by another window', async () => {
        const storage = memoryStorage();
        recordRenderCrash(storage, { now: 1000, sessionId: 'a', skipRequested: true });
        const read = createRecoveringSnapshotSource({
            now: () => 2000,
            readSnapshot: () => Promise.resolve(snapshot('a')),
            selectSession: () => Promise.resolve({ ownerWindowKey: 'other' }),
            storage,
        });
        expect((await read()).selectedSessionId).toBe('a');
    });
});

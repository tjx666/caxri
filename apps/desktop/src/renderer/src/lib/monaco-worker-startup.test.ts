import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    editorWorkersCreated,
    editorWorkerStartupSummary,
    monitorEditorWorkerStartup,
    releaseStalledEditorWorkers,
    resetEditorWorkerStartupForTests,
} from './monaco-worker-startup';

/**
 * Stands in for the Worker Monaco receives. Only the members the watcher touches are real; `dispatchEvent` is inherited
 * from `EventTarget` so a dispatched `error` reaches a listener registered the way Monaco registers its own.
 */
class FakeWorker extends EventTarget {
    terminated = 0;

    terminate(): void {
        this.terminated += 1;
    }

    reply(): void {
        this.dispatchEvent(new MessageEvent('message', { data: 'any-reply' }));
    }
}

function createWorker(): FakeWorker & Worker {
    return new FakeWorker() as unknown as FakeWorker & Worker;
}

afterEach(() => {
    resetEditorWorkerStartupForTests();
    vi.useRealTimers();
});

describe('Monaco worker startup watch', () => {
    it('hands back the same Worker it was given', () => {
        const worker = createWorker();

        expect(monitorEditorWorkerStartup(worker, 'editorWorkerService')).toBe(worker);
        expect(editorWorkersCreated()).toBe(1);
    });

    it('counts a Worker that answers anything at all as started', () => {
        vi.useFakeTimers();
        const worker = createWorker();
        monitorEditorWorkerStartup(worker, 'editorWorkerService');

        worker.reply();
        vi.advanceTimersByTime(30_000);

        expect(editorWorkerStartupSummary()).toMatchObject({
            created: 1,
            started: 1,
            stalled: 0,
            stalledNow: 0,
        });
    });

    it('counts a Worker that never answers as a startup stall once its budget passes', () => {
        vi.useFakeTimers();
        monitorEditorWorkerStartup(createWorker(), 'editorWorkerService');

        expect(editorWorkerStartupSummary().stalledNow).toBe(0);
        vi.advanceTimersByTime(5_000);

        expect(editorWorkerStartupSummary()).toMatchObject({
            created: 1,
            started: 0,
            stalled: 1,
            stalledNow: 1,
        });
    });

    it('tells Monaco a stalled Worker is gone before terminating it', () => {
        vi.useFakeTimers();
        const worker = createWorker();
        const seen: string[] = [];
        // Monaco registers its own handler on the Worker it was handed; the release has to reach that listener.
        worker.addEventListener('error', () => seen.push('error'));
        monitorEditorWorkerStartup(worker, 'editorWorkerService');
        vi.advanceTimersByTime(5_000);

        expect(releaseStalledEditorWorkers()).toBe(1);

        expect(seen).toEqual(['error']);
        expect(worker.terminated).toBe(1);
        expect(editorWorkerStartupSummary()).toMatchObject({
            stalled: 1,
            stalledNow: 0,
            recovered: 1,
        });
    });

    it('leaves a healthy Worker alone', () => {
        vi.useFakeTimers();
        const worker = createWorker();
        monitorEditorWorkerStartup(worker, 'editorWorkerService');
        worker.reply();
        vi.advanceTimersByTime(5_000);

        expect(releaseStalledEditorWorkers()).toBe(0);
        expect(worker.terminated).toBe(0);
    });

    it('keeps the per-lifetime totals while releasing only what is still stalled', () => {
        vi.useFakeTimers();
        monitorEditorWorkerStartup(createWorker(), 'editorWorkerService');
        vi.advanceTimersByTime(5_000);
        releaseStalledEditorWorkers();
        monitorEditorWorkerStartup(createWorker(), 'editorWorkerService');
        vi.advanceTimersByTime(5_000);

        expect(editorWorkerStartupSummary()).toMatchObject({
            created: 2,
            started: 0,
            stalled: 2,
            stalledNow: 1,
            recovered: 1,
        });
    });
});

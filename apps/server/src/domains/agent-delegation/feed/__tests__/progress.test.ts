import type { AgentDelegationProgress } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELEGATION_PROGRESS_INTERVAL_MS, DelegationProgress } from '../progress';

function fixture() {
    const emit = vi.fn<(progress: AgentDelegationProgress) => void>();
    const progress = new DelegationProgress(emit, () => Date.now());
    progress.track('task', 'session');
    return { emit, progress };
}

describe('DelegationProgress', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000_000);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('emits the first step at once', () => {
        const { emit, progress } = fixture();

        progress.observe('task', 'Reading a.ts');

        expect(emit.mock.calls).toEqual([
            [{ sessionId: 'session', delegationId: 'task', step: 'Reading a.ts' }],
        ]);
    });

    it('emits nothing for a step that did not change', () => {
        const { emit, progress } = fixture();

        progress.observe('task', 'Reading a.ts');
        vi.advanceTimersByTime(5000);
        progress.observe('task', 'Reading a.ts');
        progress.observe('task', undefined);
        vi.advanceTimersByTime(DELEGATION_PROGRESS_INTERVAL_MS);

        // The cleared step is a change; the repeated one before it was not.
        expect(emit.mock.calls).toEqual([
            [{ sessionId: 'session', delegationId: 'task', step: 'Reading a.ts' }],
            [{ sessionId: 'session', delegationId: 'task' }],
        ]);
    });

    it('collapses changes within a second into one trailing event with the newest step', () => {
        const { emit, progress } = fixture();

        progress.observe('task', 'Reading a.ts');
        vi.advanceTimersByTime(100);
        progress.observe('task', 'Editing a.ts');
        vi.advanceTimersByTime(100);
        progress.observe('task', 'Running tests');
        expect(emit).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(DELEGATION_PROGRESS_INTERVAL_MS - 200 - 1);
        expect(emit).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);

        expect(emit.mock.calls.at(-1)).toEqual([
            { sessionId: 'session', delegationId: 'task', step: 'Running tests' },
        ]);
        expect(emit).toHaveBeenCalledTimes(2);
    });

    it('emits at most once per second however fast the step changes', () => {
        const { emit, progress } = fixture();

        for (let index = 0; index < 50; index += 1) {
            progress.observe('task', `Step ${index}`);
            vi.advanceTimersByTime(100);
        }
        vi.advanceTimersByTime(DELEGATION_PROGRESS_INTERVAL_MS);

        // 5 seconds of changes: the leading event, then one every second, then no more once the steps stop.
        expect(emit.mock.calls.length).toBeLessThanOrEqual(6);
        expect(emit.mock.calls.at(-1)?.[0].step).toBe('Step 49');
    });

    it('skips the trailing event when the step returned to the one already shown', () => {
        const { emit, progress } = fixture();

        progress.observe('task', 'Reading a.ts');
        progress.observe('task', 'Editing a.ts');
        progress.observe('task', 'Reading a.ts');
        vi.advanceTimersByTime(DELEGATION_PROGRESS_INTERVAL_MS);

        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('drops a pending event when the task settles, and ignores a task it does not follow', () => {
        const { emit, progress } = fixture();
        progress.observe('task', 'Reading a.ts');
        progress.observe('task', 'Editing a.ts');

        progress.settle('task');
        vi.advanceTimersByTime(DELEGATION_PROGRESS_INTERVAL_MS * 2);
        progress.observe('task', 'Running tests');
        progress.observe('unknown', 'Running tests');

        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('drops every pending event when closed', () => {
        const { emit, progress } = fixture();
        progress.observe('task', 'Reading a.ts');
        progress.observe('task', 'Editing a.ts');

        progress.close();
        vi.advanceTimersByTime(DELEGATION_PROGRESS_INTERVAL_MS * 2);

        expect(emit).toHaveBeenCalledTimes(1);
    });
});

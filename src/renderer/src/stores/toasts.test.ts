import { CaxriError } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    refreshWorkbench: vi.fn(() => Promise.resolve()),
}));

vi.mock('./workbench', () => ({ refreshWorkbench: mocks.refreshWorkbench }));

import { describeFailure, dismissToast, pushToast, tryCommand, useToastStore } from './toasts';

describe('toast store', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.refreshWorkbench.mockClear();
        useToastStore.setState({ toasts: [] });
    });

    afterEach(() => {
        // Drain any still-pending auto-dismiss timers before restoring real timers, otherwise a
        // leaked timer from one test can fire during a later test.
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('pushes a notification and reports it in arrival order', () => {
        pushToast('info', 'first');
        pushToast('info', 'second');

        expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
            'first',
            'second',
        ]);
    });

    it('dismisses a single toast by id and leaves the others', () => {
        pushToast('info', 'first');
        pushToast('info', 'second');
        const [firstId] = useToastStore.getState().toasts.map((toast) => toast.id);

        dismissToast(firstId);

        expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual(['second']);
    });

    it('dismisses every toast when no id is given', () => {
        pushToast('info', 'first');
        pushToast('info', 'second');

        dismissToast();

        expect(useToastStore.getState().toasts).toEqual([]);
    });

    it('auto-dismisses a non-persistent toast after the timeout', () => {
        pushToast('info', 'auto-dismiss me');

        vi.advanceTimersByTime(3_999);
        expect(useToastStore.getState().toasts).toHaveLength(1);

        vi.advanceTimersByTime(1);
        expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it('never auto-dismisses an error toast', () => {
        pushToast('error', 'stays until dismissed');

        vi.advanceTimersByTime(60_000);

        expect(useToastStore.getState().toasts).toHaveLength(1);
    });

    it('never auto-dismisses an info toast opted into persist', () => {
        pushToast('info', 'stays until dismissed', { persist: true });

        vi.advanceTimersByTime(60_000);

        expect(useToastStore.getState().toasts).toHaveLength(1);
    });

    it('keeps an optional follow-up action on the notification', () => {
        const onSelect = vi.fn();
        pushToast('success', 'recovered', {
            action: { label: 'Open Settings', onSelect },
        });

        expect(useToastStore.getState().toasts[0].action).toEqual({
            label: 'Open Settings',
            onSelect,
        });
    });

    it('re-arms the same toast instead of stacking an identical repeat', () => {
        pushToast('info', 'duplicate message');
        const [firstId] = useToastStore.getState().toasts.map((toast) => toast.id);

        vi.advanceTimersByTime(3_000);
        pushToast('info', 'duplicate message');

        expect(useToastStore.getState().toasts).toHaveLength(1);
        expect(useToastStore.getState().toasts[0].id).toBe(firstId);

        // The repeat reset the timer, so the toast must still be alive 3s+1s after the repeat even
        // though that is more than 4s after the original push.
        vi.advanceTimersByTime(3_000);
        expect(useToastStore.getState().toasts).toHaveLength(1);

        vi.advanceTimersByTime(1_000);
        expect(useToastStore.getState().toasts).toHaveLength(0);
    });

    it('does not re-arm when the newest toast differs in kind or message', () => {
        pushToast('info', 'same text');
        pushToast('error', 'same text');

        expect(useToastStore.getState().toasts).toHaveLength(2);
    });

    it('evicts the oldest toast beyond the visible cap and clears its timer', () => {
        pushToast('info', 'one');
        pushToast('info', 'two');
        pushToast('info', 'three');
        pushToast('info', 'four');

        const messages = useToastStore.getState().toasts.map((toast) => toast.message);
        expect(messages).toEqual(['two', 'three', 'four']);

        // The evicted toast's timer must have been cleared, so advancing past its original deadline
        // must not throw or affect the remaining toasts.
        vi.advanceTimersByTime(4_000);
        expect(useToastStore.getState().toasts).toEqual([]);
    });

    it('describes a CaxriError UNAVAILABLE code with actionable copy', () => {
        expect(describeFailure(new CaxriError('UNAVAILABLE', 'raw message'), 'Save file')).toBe(
            'Save file: Caxri is not ready yet.',
        );
    });

    it('describes a CaxriError TIMEOUT code with actionable copy', () => {
        expect(describeFailure(new CaxriError('TIMEOUT', 'raw message'), 'Save file')).toBe(
            'Save file: Caxri did not respond in time.',
        );
    });

    it('falls back to the CaxriError message for any other code', () => {
        expect(describeFailure(new CaxriError('NOT_FOUND', 'File is gone'), 'Save file')).toBe(
            'File is gone',
        );
    });

    it('falls back to the label for a non-Error rejection', () => {
        expect(describeFailure('not an Error instance', 'Save file')).toBe('Save file');
    });

    it('uses the plain Error message for a non-CaxriError rejection', () => {
        expect(describeFailure(new Error('disk is full'), 'Save file')).toBe('disk is full');
    });

    it('tryCommand resolves with the run() result on success without refreshing', async () => {
        const run = vi.fn(() => Promise.resolve('ok'));

        const result = await tryCommand('Save file', run);

        expect(result).toBe('ok');
        expect(mocks.refreshWorkbench).not.toHaveBeenCalled();
        expect(useToastStore.getState().toasts).toEqual([]);
    });

    it('tryCommand refreshes the workbench after a successful run when requested', async () => {
        const run = vi.fn(() => Promise.resolve('ok'));

        await tryCommand('Save file', run, { refresh: true });

        expect(mocks.refreshWorkbench).toHaveBeenCalledOnce();
    });

    it('tryCommand funnels a rejection into exactly one error toast and resolves undefined', async () => {
        const run = vi.fn(() => Promise.reject(new CaxriError('IO', 'disk is full')));

        const result = await tryCommand('Save file', run);

        expect(result).toBeUndefined();
        expect(mocks.refreshWorkbench).not.toHaveBeenCalled();
        const toasts = useToastStore.getState().toasts;
        expect(toasts).toHaveLength(1);
        expect(toasts[0]).toMatchObject({ kind: 'error', message: 'disk is full', persist: true });
    });

    it('tryCommand does not refresh the workbench when the run rejects', async () => {
        const run = vi.fn(() => Promise.reject(new Error('boom')));

        await tryCommand('Save file', run, { refresh: true });

        expect(mocks.refreshWorkbench).not.toHaveBeenCalled();
    });
});

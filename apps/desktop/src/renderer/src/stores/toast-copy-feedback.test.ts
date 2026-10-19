import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COPY_FEEDBACK_RESET_MS } from '../components/copy-feedback';
import {
    copyFeedbackKey,
    copyFeedbackKeyOf,
    copyWithToastFeedback,
    getCopyFeedback,
    isCopyToastAction,
} from './toast-copy-feedback';

describe('toast copy feedback', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('shows Copied after a successful copy and restores the button after the reset interval', async () => {
        const key = copyFeedbackKey('clipboard.copyCommand', 'sudo sysctl x');
        const writeText = vi.fn(() => Promise.resolve());
        expect(getCopyFeedback(key)).toBe('idle');
        await expect(copyWithToastFeedback(key, 'sudo sysctl x', { writeText })).resolves.toBe(
            'copied',
        );
        expect(writeText).toHaveBeenCalledWith('sudo sysctl x');
        expect(getCopyFeedback(key)).toBe('copied');
        vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS);
        expect(getCopyFeedback(key)).toBe('idle');
    });

    it('shows a failed copy in place instead of rejecting', async () => {
        const key = copyFeedbackKey('diagnostics.copyFailure', 'detail');
        await copyWithToastFeedback(key, 'detail', {
            writeText: () => Promise.reject(new Error('x')),
        });
        expect(getCopyFeedback(key)).toBe('failed');
        vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS);
        expect(getCopyFeedback(key)).toBe('idle');
    });

    it('restarts the interval on a second click', async () => {
        const key = copyFeedbackKey('clipboard.copyCommand', 'a');
        const clipboard = { writeText: () => Promise.resolve() };
        await copyWithToastFeedback(key, 'a', clipboard);
        vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS - 500);
        await copyWithToastFeedback(key, 'a', clipboard);
        vi.advanceTimersByTime(COPY_FEEDBACK_RESET_MS - 500);
        expect(getCopyFeedback(key)).toBe('copied');
        vi.advanceTimersByTime(500);
        expect(getCopyFeedback(key)).toBe('idle');
    });

    it('recognizes only the two copy follow-ups', () => {
        expect(isCopyToastAction({ id: 'diagnostics.copyFailure', params: { text: 't' } })).toBe(
            true,
        );
        expect(isCopyToastAction({ id: 'updates.show' })).toBe(false);
        expect(copyFeedbackKeyOf({ id: 'updates.show' })).toBeUndefined();
        expect(copyFeedbackKeyOf({ id: 'clipboard.copyCommand', params: { text: 'a' } })).toBe(
            copyFeedbackKey('clipboard.copyCommand', 'a'),
        );
    });
});

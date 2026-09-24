import { describe, expect, it, vi } from 'vitest';

import { createTerminalFrameBatch } from '../frame-batch';

describe('mobile Terminal frame batch', () => {
    it('writes all output received in one animation frame exactly once', () => {
        const callbacks: Array<() => void> = [];
        const write = vi.fn();
        const batch = createTerminalFrameBatch({
            schedule: (callback) => {
                callbacks.push(callback);
                return callbacks.length;
            },
            cancel: vi.fn(),
            write,
        });
        batch.push('one');
        expect(write).not.toHaveBeenCalled();
        batch.push('two');
        expect(callbacks).toHaveLength(1);
        expect(write).not.toHaveBeenCalled();
        callbacks[0]?.();
        expect(write).toHaveBeenCalledExactlyOnceWith('onetwo');
    });

    it('drops queued output when a new snapshot or Terminal generation starts', () => {
        const callbacks: Array<() => void> = [];
        const cancel = vi.fn();
        const write = vi.fn();
        const batch = createTerminalFrameBatch({
            schedule: (callback) => {
                callbacks.push(callback);
                return callbacks.length;
            },
            cancel,
            write,
        });
        batch.push('stale');
        batch.reset();
        callbacks[0]?.();
        expect(write).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalledExactlyOnceWith(1);
        batch.push('fresh');
        callbacks[1]?.();
        expect(write).toHaveBeenCalledExactlyOnceWith('fresh');
    });
});

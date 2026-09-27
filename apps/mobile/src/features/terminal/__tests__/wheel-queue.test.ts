import { describe, expect, it, vi } from 'vitest';

import { createTerminalWheelQueue } from '../wheel-queue';

describe('mobile Terminal wheel queue', () => {
    it('folds frames that arrive during a request into one bounded follow-up', async () => {
        const send = vi.fn(() => Promise.resolve(null));
        const queue = createTerminalWheelQueue(send, vi.fn());
        queue.add({ col: 3, lines: -2, row: 4 });
        queue.add({ col: 3, lines: -30, row: 4 });
        queue.add({ col: 5, lines: -40, row: 6 });
        expect(send).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
        expect(send.mock.calls).toEqual([
            [{ col: 3, lines: -2, row: 4 }],
            [{ col: 5, lines: -50, row: 6 }],
            [{ col: 5, lines: -20, row: 6 }],
        ]);
    });

    it('drops pending frames after a failure instead of replaying stale scrolls', async () => {
        const onError = vi.fn();
        const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(null);
        const queue = createTerminalWheelQueue(send, onError);
        queue.add({ col: 1, lines: 3, row: 1 });
        await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
        queue.add({ col: 1, lines: 1, row: 1 });
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
        expect(send).toHaveBeenLastCalledWith({ col: 1, lines: 1, row: 1 });
    });
});

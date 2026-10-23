import { describe, expect, it, vi } from 'vitest';

import { ValidationSweep } from '../validation-sweep';

describe('ValidationSweep', () => {
    it('joins a running sweep and reuses a finished one for five seconds', async () => {
        let now = 1_000;
        const pending = Promise.withResolvers<void>();
        const sweep = vi.fn(() => pending.promise);
        const sweeps = new ValidationSweep(sweep, () => now);

        // `activate` and `browser-window-focus` fire together: the second joins the first.
        const both = Promise.all([sweeps.run(), sweeps.run()]);
        pending.resolve();
        await both;
        expect(sweep).toHaveBeenCalledTimes(1);

        sweep.mockResolvedValue();
        now += 4_999;
        await sweeps.run();
        expect(sweep).toHaveBeenCalledTimes(1);
        now += 1;
        await sweeps.run();
        expect(sweep).toHaveBeenCalledTimes(2);
    });

    it('retries right after a failed sweep', async () => {
        const sweep = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error('git unavailable'));
        sweep.mockResolvedValue();
        const sweeps = new ValidationSweep(sweep, () => 1_000);

        await expect(sweeps.run()).rejects.toThrow('git unavailable');
        await sweeps.run();
        expect(sweep).toHaveBeenCalledTimes(2);
    });
});

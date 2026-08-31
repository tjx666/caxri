import { describe, expect, it, vi } from 'vitest';

import { MutationAdmission } from '../mutation-admission';

describe('MutationAdmission', () => {
    it('rejects a mutation before its side effects run after admission closes', async () => {
        const admission = new MutationAdmission();
        const mutate = vi.fn(() => Promise.resolve('done'));
        admission.close();

        await expect(admission.run(mutate)).rejects.toMatchObject({ code: 'UNAVAILABLE' });

        expect(mutate).not.toHaveBeenCalled();
    });

    it('always drains a mutation that fails after admission', async () => {
        const admission = new MutationAdmission();
        const failure = new Error('mutation failed');

        await expect(
            admission.run(() => {
                throw failure;
            }),
        ).rejects.toBe(failure);
        admission.close();
        await expect(admission.waitForDrain()).resolves.toBeUndefined();
    });
});

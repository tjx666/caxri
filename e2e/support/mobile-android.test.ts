import { describe, expect, it, vi } from 'vitest';

import { setMobileNetworkAvailable } from './mobile-android';

describe('Android Acceptance network isolation', () => {
    it('disables and restores both emulator network transports', async () => {
        const shell = vi.fn().mockResolvedValue('');

        await setMobileNetworkAvailable('emulator-5554', false, shell);
        await setMobileNetworkAvailable('emulator-5554', true, shell);

        expect(shell.mock.calls).toEqual([
            ['emulator-5554', ['svc', 'wifi', 'disable']],
            ['emulator-5554', ['svc', 'data', 'disable']],
            ['emulator-5554', ['svc', 'wifi', 'enable']],
            ['emulator-5554', ['svc', 'data', 'enable']],
        ]);
    });

    it('still attempts the second transport when the first command fails', async () => {
        const shell = vi
            .fn()
            .mockRejectedValueOnce(new Error('Wi-Fi toggle failed'))
            .mockResolvedValueOnce('');

        await expect(setMobileNetworkAvailable('emulator-5554', false, shell)).rejects.toThrow(
            'Mobile Acceptance could not disable every network transport',
        );
        expect(shell.mock.calls).toEqual([
            ['emulator-5554', ['svc', 'wifi', 'disable']],
            ['emulator-5554', ['svc', 'data', 'disable']],
        ]);
    });
});

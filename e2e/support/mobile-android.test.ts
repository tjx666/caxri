import { describe, expect, it, vi } from 'vitest';

import { androidScreenSize } from '../../scripts/mobile-android-display-state.ts';
import { androidTapPoint, setMobileNetworkAvailable } from './mobile-android';

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

describe('Android Acceptance taps by bounds', () => {
    const conversation = { bottom: 2000, left: 0, right: 1080, top: 300 };

    it('taps the center of a control inside its viewport, or the row an offset reaches', () => {
        const button = { bottom: 1100, left: 100, right: 200, top: 1000 };

        expect(androidTapPoint(button, conversation)).toEqual({ x: 150, y: 1050 });
        expect(androidTapPoint(button, conversation, 2)).toEqual({ x: 150, y: 1250 });
    });

    it('refuses a control scrolled under the header or past the list, and a row offset off the end', () => {
        expect(
            androidTapPoint({ bottom: 320, left: 100, right: 200, top: 220 }, conversation),
        ).toBeNull();
        expect(
            androidTapPoint({ bottom: 2080, left: 100, right: 200, top: 1980 }, conversation),
        ).toBeNull();
        expect(
            androidTapPoint({ bottom: 1900, left: 100, right: 200, top: 1800 }, conversation, 2),
        ).toBeNull();
    });

    it('reads the screen the emulator draws at, preferring a case override', () => {
        expect(androidScreenSize('Physical size: 1080x2400')).toEqual({
            height: 2400,
            width: 1080,
        });
        expect(androidScreenSize('Physical size: 1080x2400\nOverride size: 2560x1600')).toEqual({
            height: 1600,
            width: 2560,
        });
        expect(() => androidScreenSize('')).toThrow('display size is unavailable');
    });
});

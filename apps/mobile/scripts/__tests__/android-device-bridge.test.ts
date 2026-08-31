import { describe, expect, it, vi } from 'vitest';

import { runAndroidAdb } from '../android-device-bridge';

describe('Android device bridge', () => {
    it('bounds ADB commands and keeps device output out of timeout failures', () => {
        const spawn = vi.fn(() => ({
            error: Object.assign(new Error('secret device output'), { code: 'ETIMEDOUT' }),
            status: null,
            stdout: '',
        }));

        expect(() => runAndroidAdb('emulator-5554', ['shell', 'dumpsys'], { spawn })).toThrow(
            'adb timed out',
        );
        expect(spawn).toHaveBeenCalledWith(
            expect.stringContaining('adb'),
            ['-s', 'emulator-5554', 'shell', 'dumpsys'],
            expect.objectContaining({ timeout: 15_000, killSignal: 'SIGTERM' }),
        );
    });
});

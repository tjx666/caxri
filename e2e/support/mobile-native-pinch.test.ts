import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MobileAndroid from './mobile-android';
import { mobileSemantics, runMobileDeviceCommand } from './mobile-android';
import { pinchTerminal } from './mobile-native-pinch';

vi.mock('./mobile-android', async (importOriginal) => ({
    ...(await importOriginal<typeof MobileAndroid>()),
    mobileDisplayState: vi.fn(() =>
        Promise.resolve({ size: { physical: { width: 1080, height: 2400 } } }),
    ),
    mobileSemantics: vi.fn(),
    runMobileDeviceCommand: vi.fn(),
}));

describe('native Terminal pinch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(mobileSemantics).mockResolvedValue(
            [
                { checkId: 'session-detail', bounds: '[0,0][1080,2400]' },
                { checkId: 'terminal-take-over', bounds: '[0,2200][100,2300]' },
                { checkId: 'terminal-live-webview', bounds: '[0,200][1080,2200]' },
            ].map((node) => ({
                ...node,
                enabled: true,
                checked: false,
                clickable: false,
                selected: false,
            })),
        );
    });

    it('refuses a physical device before issuing commands', async () => {
        await expect(pinchTerminal('192.0.2.1:5555', 'pinch-in')).rejects.toThrow(
            'disposable emulator',
        );
        expect(mobileSemantics).not.toHaveBeenCalled();
        expect(runMobileDeviceCommand).not.toHaveBeenCalled();
    });

    it.each([
        'OK (1 test)',
        'INSTRUMENTATION_RESULT: status=failed\nINSTRUMENTATION_CODE: 0',
        'INSTRUMENTATION_RESULT: status=ok\nINSTRUMENTATION_RESULT: gesture=pinch-out\nINSTRUMENTATION_CODE: -1',
    ])(
        'rejects a successful shell exit without the requested gesture receipt: %s',
        async (output) => {
            vi.mocked(runMobileDeviceCommand).mockResolvedValue(output);
            await expect(pinchTerminal('emulator-5556', 'pinch-in')).rejects.toThrow(
                'did not report success',
            );
        },
    );

    it('pinches the leased Terminal only while the phone holds the lease', async () => {
        await expect(pinchTerminal('emulator-5556', 'pinch-out', 'leased')).rejects.toThrow(
            'The leased Terminal is unavailable',
        );
        vi.mocked(mobileSemantics).mockResolvedValue(
            [
                { checkId: 'session-detail', bounds: '[0,0][1080,2400]' },
                { checkId: 'terminal-release', bounds: '[0,2200][100,2300]' },
                { checkId: 'terminal-live-webview', bounds: '[0,200][1080,2200]' },
            ].map((node) => ({
                ...node,
                enabled: true,
                checked: false,
                clickable: false,
                selected: false,
            })),
        );
        vi.mocked(runMobileDeviceCommand).mockResolvedValue(
            'INSTRUMENTATION_RESULT: status=ok\nINSTRUMENTATION_RESULT: gesture=pinch-out\nINSTRUMENTATION_CODE: -1',
        );
        await pinchTerminal('emulator-5556', 'pinch-out', 'leased');
        await expect(pinchTerminal('emulator-5556', 'pinch-out')).rejects.toThrow(
            'The observing Terminal is unavailable',
        );
    });

    it('checks the foreground Terminal again after a confirmed gesture', async () => {
        vi.mocked(runMobileDeviceCommand).mockResolvedValue(
            'INSTRUMENTATION_RESULT: status=ok\nINSTRUMENTATION_RESULT: gesture=pinch-in\nINSTRUMENTATION_CODE: -1',
        );
        await pinchTerminal('emulator-5556', 'pinch-in');
        expect(mobileSemantics).toHaveBeenCalledTimes(2);
    });
});

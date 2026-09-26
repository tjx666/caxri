import { homedir } from 'node:os';
import { join } from 'node:path';

import {
    androidBounds,
    mobileDisplayState,
    mobileSemantics,
    runMobileDeviceCommand,
} from './mobile-android';

const adb = join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
const fixtureInstrumentation = 'caxri.acceptance.ime/.FixtureGestureInstrumentation';

type PinchDirection = 'pinch-in' | 'pinch-out';

const terminalBounds = async (serial: string) => {
    const nodes = await mobileSemantics(serial);
    const webview = nodes.find(({ checkId }) => checkId === 'terminal-live-webview');
    const bounds = webview && androidBounds(webview.bounds);
    if (
        !bounds ||
        nodes.every(({ checkId }) => checkId !== 'session-detail') ||
        nodes.every(({ checkId, enabled }) => !(checkId === 'terminal-take-over' && enabled)) ||
        nodes.some(({ checkId }) => checkId === 'terminal-release')
    )
        throw new Error('The read-only Terminal is unavailable for native pinch');
    const display = await mobileDisplayState(serial);
    const frame = display.size.override ?? display.size.physical;
    if (
        bounds.left < 0 ||
        bounds.top < 0 ||
        bounds.right > frame.width ||
        bounds.bottom > frame.height ||
        bounds.right - bounds.left < 120 ||
        bounds.bottom - bounds.top < 120
    )
        throw new Error('The native pinch bounds are outside the emulator framebuffer');
    return bounds;
};

/**
 * Uses the acceptance APK's UiAutomation instrumentation to inject one real two-pointer gesture. Both semantic reads
 * independently require Caxri to be foreground.
 */
export async function pinchReadOnlyTerminal(
    serial: string,
    direction: PinchDirection,
): Promise<void> {
    if (!/^emulator-\d+$/u.test(serial))
        throw new Error('Native pinch requires an explicit disposable emulator serial');
    const bounds = await terminalBounds(serial);
    const output = await runMobileDeviceCommand(
        adb,
        [
            '-s',
            serial,
            'shell',
            'am',
            'instrument',
            '-w',
            '-e',
            'gesture',
            direction,
            ...Object.entries(bounds).flatMap(([key, value]) => ['-e', key, String(value)]),
            fixtureInstrumentation,
        ],
        'capture',
        20_000,
    );
    if (
        !/^INSTRUMENTATION_RESULT: status=ok$/mu.test(output) ||
        !new RegExp(`^INSTRUMENTATION_RESULT: gesture=${direction}$`, 'mu').test(output) ||
        !/^INSTRUMENTATION_CODE: -1$/mu.test(output)
    )
        throw new Error('Native pinch instrumentation did not report success');
    await terminalBounds(serial);
}

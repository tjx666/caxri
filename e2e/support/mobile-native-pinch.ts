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

/**
 * `observing` pinches the read-only view of the Desktop grid; `leased` pinches the phone's own grid while it holds the
 * lease, which reflows the grid.
 */
type PinchTerminalState = 'leased' | 'observing';

const terminalBounds = async (serial: string, state: PinchTerminalState) => {
    const nodes = await mobileSemantics(serial);
    const webview = nodes.find(({ checkId }) => checkId === 'terminal-live-webview');
    const bounds = webview && androidBounds(webview.bounds);
    const isLeased = nodes.some(({ checkId }) => checkId === 'terminal-release');
    const canTakeOver = nodes.some(
        ({ checkId, enabled }) => checkId === 'terminal-take-over' && enabled,
    );
    if (
        !bounds ||
        nodes.every(({ checkId }) => checkId !== 'session-detail') ||
        (state === 'leased' ? !isLeased : isLeased || !canTakeOver)
    )
        throw new Error(`The ${state} Terminal is unavailable for native pinch`);
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

const assertDisposableEmulator = (serial: string): void => {
    if (!/^emulator-\d+$/u.test(serial))
        throw new Error('Native pinch requires an explicit disposable emulator serial');
};

/**
 * Uses the acceptance APK's UiAutomation instrumentation to inject one real two-pointer gesture. Both semantic reads
 * independently require Caxri to be foreground.
 */
export async function pinchTerminal(
    serial: string,
    direction: PinchDirection,
    state: PinchTerminalState = 'observing',
): Promise<void> {
    assertDisposableEmulator(serial);
    await pinchWithin(serial, direction, await terminalBounds(serial, state));
    await terminalBounds(serial, state);
}

/**
 * Injects one real two-pointer pinch centered in `bounds` through the acceptance APK's UiAutomation instrumentation.
 */
export async function pinchWithin(
    serial: string,
    direction: PinchDirection,
    bounds: { bottom: number; left: number; right: number; top: number },
): Promise<void> {
    assertDisposableEmulator(serial);
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
}

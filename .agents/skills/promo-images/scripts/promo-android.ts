import { adbShell } from '../../../../e2e/support/mobile-android.ts';

/**
 * Demo-mode commands for a status bar that shows nothing of the emulator's real state: a fixed clock, full battery and
 * Wi-Fi, no cellular signal, no notifications.
 */
const DEMO_STATUS_BAR = [
    ['exit'],
    ['enter'],
    ['clock', '-e', 'hhmm', '0941'],
    ['battery', '-e', 'level', '100', '-e', 'plugged', 'false'],
    ['network', '-e', 'wifi', 'show', '-e', 'level', '4', '-e', 'fully', 'true'],
    ['network', '-e', 'mobile', 'hide'],
    ['notifications', '-e', 'visible', 'false'],
];

/**
 * Puts the phone's status bar in demo mode. The run applies it while preparing the emulator and again right before the
 * phone capture, because on an emulator that has just booted SystemUI can drop a demo command (one capture lost the
 * Wi-Fi icon). Each pass leaves demo mode first: repeating `network wifi show` inside it adds a second Wi-Fi icon.
 * Needs `sysui_demo_allowed`, which preparing sets.
 */
export async function showDemoStatusBar(serial: string): Promise<void> {
    for (const command of DEMO_STATUS_BAR) {
        // eslint-disable-next-line no-await-in-loop -- SystemUI applies demo commands in order
        await adbShell(serial, [
            'am',
            'broadcast',
            '-a',
            'com.android.systemui.demo',
            '-e',
            'command',
            ...command,
        ]);
    }
}

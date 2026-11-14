import { describe, expect, it } from 'vitest';

import { mobileDeviceCommandLabel } from './mobile-device-command-label';

const adb = '/Users/me/Library/Android/sdk/platform-tools/adb';

describe('mobileDeviceCommandLabel', () => {
    it('names the adb subcommand and the shell command without their arguments', () => {
        expect(
            mobileDeviceCommandLabel(adb, ['-s', 'emulator-5554', 'shell', 'uiautomator', 'dump']),
        ).toBe('adb shell uiautomator');
        expect(
            mobileDeviceCommandLabel(adb, [
                '-s',
                'emulator-5554',
                'push',
                '/tmp/a.jpg',
                '/sdcard/a.jpg',
            ]),
        ).toBe('adb push');
        expect(mobileDeviceCommandLabel(adb, ['shell', '/data/local/tmp/probe'])).toBe('adb shell');
    });

    it('names the device helper script and its subcommand', () => {
        expect(
            mobileDeviceCommandLabel('bun', [
                'run',
                '/Users/me/caxri/apps/mobile/scripts/android-device.ts',
                'tap',
                '--check-id',
                'session-row-1',
            ]),
        ).toBe('android-device tap');
    });

    it('drops anything that is not a command name', () => {
        expect(mobileDeviceCommandLabel('/bin/ps', ['-axo', 'pid=,args='])).toBe('ps');
        expect(mobileDeviceCommandLabel('bun', ['-e', 'process.exit(1)'])).toBe('bun');
        expect(mobileDeviceCommandLabel('/opt/My Tool', [])).toBe('command');
    });
});

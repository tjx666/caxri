import { describe, expect, it } from 'vitest';

import { androidNotRespondingApps, assertAndroidResponsive } from '../mobile-acceptance-anr';

const WINDOWS = [
    '  Window #3: WindowStateAnimator{89a1fac Application Not Responding: com.android.systemui}',
    '  mCurrentFocus=Window{228a368 u0 Application Not Responding: com.google.android.apps.nexuslauncher}',
    '    mFocusedWindow=Window{228a368 u0 Application Not Responding: com.google.android.apps.nexuslauncher}',
].join('\n');

describe('mobile acceptance responsiveness', () => {
    it('names each app with an open "isn\'t responding" dialog once', () => {
        expect(androidNotRespondingApps(WINDOWS)).toEqual([
            'com.android.systemui',
            'com.google.android.apps.nexuslauncher',
        ]);
        expect(
            androidNotRespondingApps('  mCurrentFocus=Window{1 u0 com.caxri.mobile/.MainActivity}'),
        ).toEqual([]);
    });

    it('fails with the reboot command when a dialog is open, and passes otherwise', () => {
        const calls: string[] = [];
        const read = (windows: string) => (arguments_: string[]) => {
            calls.push(arguments_.join(' '));
            return windows;
        };
        expect(() => assertAndroidResponsive('emulator-5554', read(WINDOWS))).toThrow(
            /emulator-5554 shows an "isn't responding" dialog for com\.android\.systemui, com\.google\.android\.apps\.nexuslauncher\. Reboot it \(adb -s emulator-5554 reboot\)/u,
        );
        expect(() => assertAndroidResponsive('emulator-5554', read(''))).not.toThrow();
        expect(calls).toEqual(['shell dumpsys window windows', 'shell dumpsys window windows']);
    });
});

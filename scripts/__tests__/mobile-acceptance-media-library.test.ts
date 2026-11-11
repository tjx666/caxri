import { describe, expect, it } from 'vitest';

import { prepareMobileMediaLibraryAccess } from '../mobile-acceptance-media-library';

const device = (failOn?: string) => {
    const actions: string[] = [];
    return {
        actions,
        commands: {
            readDevice: () => '',
            runDevice: (arguments_: string[]) => {
                const action = arguments_.join(' ');
                actions.push(action);
                if (failOn && action.includes(failOn)) throw new Error('adb failed');
            },
        },
    };
};

describe('mobile acceptance photo library access', () => {
    it('declines the library without a prompt and resets it once', () => {
        const { actions, commands } = device();
        const reset = prepareMobileMediaLibraryAccess('emulator-5554', commands, 'declined');

        expect(actions).toContain(
            'shell pm set-permission-flags com.caxri.mobile android.permission.READ_MEDIA_IMAGES user-fixed',
        );
        expect(actions).toContain(
            'shell pm set-permission-flags com.caxri.mobile android.permission.READ_MEDIA_VISUAL_USER_SELECTED user-fixed',
        );
        actions.length = 0;
        reset();
        reset();

        expect(actions).toHaveLength(6);
        expect(actions[0]).toBe(
            'shell pm clear-permission-flags com.caxri.mobile android.permission.READ_MEDIA_IMAGES user-fixed',
        );
    });

    it('grants full image and video access, not partial access', () => {
        const { actions, commands } = device();
        prepareMobileMediaLibraryAccess('emulator-5554', commands, 'granted');

        expect(actions).toEqual([
            'shell pm grant com.caxri.mobile android.permission.READ_MEDIA_IMAGES',
            'shell pm grant com.caxri.mobile android.permission.READ_MEDIA_VIDEO',
        ]);
    });

    it('resets and fails when the emulator refuses a change', () => {
        const { actions, commands } = device('grant');

        expect(() => prepareMobileMediaLibraryAccess('emulator-5554', commands, 'granted')).toThrow(
            'adb failed',
        );
        expect(actions.at(-1)).toBe(
            'shell pm revoke com.caxri.mobile android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
        );
    });

    it('refuses a device that is not an explicit emulator', () => {
        const { actions, commands } = device();

        expect(() =>
            prepareMobileMediaLibraryAccess('192.168.1.2:5555', commands, 'declined'),
        ).toThrow('explicit disposable emulator');
        expect(actions).toEqual([]);
    });
});

import type { MobileMotionCommands } from './mobile-acceptance-motion';

const APP_ID = 'com.caxri.mobile';

/**
 * The library permissions the composer's add sheet asks for. `READ_MEDIA_VISUAL_USER_SELECTED` is Android 14's partial
 * access; declining it too keeps the system from offering "Select photos" in place of a refusal.
 */
const MEDIA_PERMISSIONS = [
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
] as const;

/**
 * How a case finds the phone's photo library: `declined` is every case's default, so the add sheet's first-open
 * permission prompt never covers a scenario that does not test it; `granted` lets a case show the recent photos row;
 * `undetermined` leaves the app never asked, so the sheet's first opening shows the system prompt.
 */
export type MobileMediaLibraryAccess = 'declined' | 'granted' | 'undetermined';

/**
 * Sets the app's photo library permission on the disposable emulator for one case and returns the idempotent reset.
 *
 * `declined` revokes the permissions and marks them `user-fixed`, as a user who chose "Don't allow" leaves them, so a
 * request returns a refusal without showing the system prompt. `granted` grants full image and video access.
 * `undetermined` revokes them and clears `user-fixed`, the state of a fresh install. Set after the app's data is
 * cleared and before the scenario launches it.
 */
export function prepareMobileMediaLibraryAccess(
    serial: string,
    commands: MobileMotionCommands,
    access: MobileMediaLibraryAccess,
): () => void {
    if (!/^emulator-\d+$/u.test(serial))
        throw new Error('Photo library access requires an explicit disposable emulator');
    const clear = (permission: string): void => {
        commands.runDevice([
            'shell',
            'pm',
            'clear-permission-flags',
            APP_ID,
            permission,
            'user-fixed',
        ]);
        commands.runDevice(['shell', 'pm', 'revoke', APP_ID, permission]);
    };
    let isResetPending = true;
    const reset = (): void => {
        if (!isResetPending) return;
        for (const permission of MEDIA_PERMISSIONS) clear(permission);
        isResetPending = false;
    };
    try {
        for (const permission of MEDIA_PERMISSIONS) {
            if (access === 'undetermined') {
                clear(permission);
            } else if (access === 'granted') {
                if (permission !== 'android.permission.READ_MEDIA_VISUAL_USER_SELECTED')
                    commands.runDevice(['shell', 'pm', 'grant', APP_ID, permission]);
            } else {
                commands.runDevice(['shell', 'pm', 'revoke', APP_ID, permission]);
                commands.runDevice([
                    'shell',
                    'pm',
                    'set-permission-flags',
                    APP_ID,
                    permission,
                    'user-fixed',
                ]);
            }
        }
    } catch (error) {
        reset();
        throw error;
    }
    return reset;
}

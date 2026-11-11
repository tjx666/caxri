import { prepareMobileAppLocale } from './mobile-acceptance-locale';
import { prepareMobileMediaLibraryAccess } from './mobile-acceptance-media-library';
import type { MobileMotionCommands } from './mobile-acceptance-motion';
import { prepareMobileLiveMotion } from './mobile-acceptance-motion';
import type { MobileAndroidCaseDefinition } from './mobile-android-cases';

/**
 * Applies one Android case's own device settings (photo library access, live motion, app language) and returns their
 * restores, newest first. The app reads each when it starts, so they land after its data is cleared and before the
 * scenario launches it. A setting that fails restores the ones already applied before the error propagates.
 */
export function prepareMobileCaseSettings(
    serial: string,
    commands: MobileMotionCommands,
    definition: Pick<MobileAndroidCaseDefinition, 'appLocale' | 'mediaLibrary' | 'motion'>,
): Array<() => void> {
    const restores: Array<() => void> = [];
    try {
        restores.unshift(
            prepareMobileMediaLibraryAccess(
                serial,
                commands,
                definition.mediaLibrary ?? 'declined',
            ),
        );
        if (definition.motion === 'live')
            restores.unshift(prepareMobileLiveMotion(serial, commands));
        if (definition.appLocale)
            restores.unshift(prepareMobileAppLocale(serial, commands, definition.appLocale));
    } catch (error) {
        for (const restore of restores) restore();
        throw error;
    }
    return restores;
}

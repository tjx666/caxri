import type { MobileMotionCommands } from './mobile-acceptance-motion';
import type { MobileAndroidAppLocale } from './mobile-android-cases';

const APP_ID = 'com.caxri.mobile';

/**
 * Android 13 (API 33) added per-app languages and the `cmd locale` shell commands that set them.
 */
const MIN_PER_APP_LOCALE_SDK = 33;

/**
 * Runs Caxri on the disposable emulator in `locale` for one case and returns the idempotent reset to the system
 * language.
 *
 * The case sets the per-app language (`cmd locale set-app-locales`) instead of the system language. Changing the system
 * language from ADB needs root (`setprop persist.sys.locale`) and a framework restart, which a release emulator image
 * refuses and which would also restart every other app the round depends on. The per-app language reaches the app the
 * same way: Android applies it to the app's configuration and default locale, which the app reads through `Intl` when
 * it starts. Set after the app's data is cleared and before the scenario launches it.
 */
export function prepareMobileAppLocale(
    serial: string,
    commands: MobileMotionCommands,
    locale: MobileAndroidAppLocale,
): () => void {
    if (!/^emulator-\d+$/u.test(serial))
        throw new Error('App language requires an explicit disposable emulator');
    const sdk = Number(commands.readDevice(['shell', 'getprop', 'ro.build.version.sdk']).trim());
    if (!Number.isSafeInteger(sdk) || sdk < MIN_PER_APP_LOCALE_SDK)
        throw new Error('App language requires Android 13 or later');
    let isResetPending = true;
    const reset = (): void => {
        if (!isResetPending) return;
        // `adb shell` joins arguments into one device command line, so the empty list is quoted for the device shell.
        commands.runDevice([
            'shell',
            'cmd',
            'locale',
            'set-app-locales',
            APP_ID,
            '--locales',
            "''",
        ]);
        isResetPending = false;
    };
    try {
        commands.runDevice([
            'shell',
            'cmd',
            'locale',
            'set-app-locales',
            APP_ID,
            '--locales',
            locale,
        ]);
        const applied = commands.readDevice(['shell', 'cmd', 'locale', 'get-app-locales', APP_ID]);
        if (!applied.toLowerCase().includes(locale.toLowerCase()))
            throw new Error('The emulator did not apply the app language');
    } catch (error) {
        reset();
        throw error;
    }
    return reset;
}

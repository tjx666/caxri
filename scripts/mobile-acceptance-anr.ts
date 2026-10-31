/**
 * The apps an Android "isn't responding" dialog is open for, from `adb shell dumpsys window`. AOSP titles that dialog's
 * window `Application Not Responding: <package>` (`AppNotRespondingDialog`).
 */
export function androidNotRespondingApps(windows: string): string[] {
    const apps = new Set<string>();
    for (const match of windows.matchAll(/Application Not Responding: ([\w.]+)/gu))
        apps.add(match[1]);
    return [...apps];
}

/**
 * Fails fast when the emulator shows an "isn't responding" dialog. It covers the screen, so pairing and every later
 * step times out with a message that points nowhere near the cause, after a release build of half an hour. A loaded
 * host (several emulators at once) is the usual trigger; a reboot clears it.
 */
export function assertAndroidResponsive(
    serial: string,
    readDevice: (arguments_: string[]) => string,
): void {
    const apps = androidNotRespondingApps(readDevice(['shell', 'dumpsys', 'window', 'windows']));
    if (apps.length > 0)
        throw new Error(
            `${serial} shows an "isn't responding" dialog for ${apps.join(', ')}. Reboot it (adb -s ${serial} reboot), wait for sys.boot_completed, then run again.`,
        );
}

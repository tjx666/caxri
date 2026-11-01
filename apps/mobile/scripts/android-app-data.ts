/**
 * Clears an Android app's data only when the app is installed. A run blocked before the release APK was ever installed
 * (a cold Gradle build killed by its budget) has nothing to clear, yet `pm clear` on the missing package failed, left
 * the isolated launch uncleaned, and refused every retry in that round. `pm list packages <id>` exits 0 and prints one
 * `package:<id>` line per substring match, so only an exact line counts as installed; a failed query still throws and
 * keeps the launch uncleaned.
 */
export function clearAndroidAppDataIfInstalled(
    appId: string,
    runDevice: (arguments_: string[]) => string,
): 'absent' | 'cleared' {
    const listed = runDevice(['shell', 'pm', 'list', 'packages', appId]);
    const isInstalled = listed.split(/\r?\n/u).some((line) => line.trim() === `package:${appId}`);
    if (!isInstalled) return 'absent';
    runDevice(['shell', 'pm', 'clear', appId]);
    return 'cleared';
}

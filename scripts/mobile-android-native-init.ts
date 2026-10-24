/**
 * ML Kit builds its components through reflection at app start. When a release build loses the constructors (R8 full
 * mode removes them unless kept), every barcode decode silently returns nothing while the app otherwise looks healthy,
 * so no screen-level check notices. The `ComponentDiscovery` warning is the only signal.
 */
const MLKIT_REGISTRAR_FAILURE = /Could not instantiate (com\.google\.mlkit\.[\w$.]+)/gu;

/**
 * Logcat arguments that read only the app's own `ComponentDiscovery` warnings, so no other log content reaches the
 * runner.
 */
export const androidNativeInitLogcatArguments = (uid: number): string[] => [
    'logcat',
    '-d',
    `--uid=${uid}`,
    '-s',
    'ComponentDiscovery:W',
];

export const parseAndroidPackageUid = (packageList: string): number => {
    const uid = Number(/\buid:(\d+)/u.exec(packageList)?.[1]);
    if (!Number.isSafeInteger(uid)) throw new Error('Android package uid is unavailable');
    return uid;
};

/**
 * Returns the ML Kit registrar classes that failed to instantiate. Only public library class names leave the log.
 */
export const findAndroidNativeInitFailures = (logcat: string): string[] => [
    ...new Set(Array.from(logcat.matchAll(MLKIT_REGISTRAR_FAILURE), (match) => match[1])),
];

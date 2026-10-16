import ANDROID_RELEASE_SIGNING_ENVIRONMENT from '../plugins/android-release-signing-environment.json';

export interface ApkBadging {
    packageName: string;
    versionCode: number;
    versionName: string;
}

export interface ReleaseSigning {
    keyAlias: string;
    keystorePath: string;
}

/**
 * Requires every release signing variable before any build starts. The error names only missing variables, never
 * values.
 */
export const readReleaseSigning = (
    environment: Readonly<Record<string, string | undefined>>,
): ReleaseSigning => {
    const missing = Object.values(ANDROID_RELEASE_SIGNING_ENVIRONMENT).filter(
        (name) => !environment[name],
    );
    if (missing.length > 0)
        throw new Error(
            `The Android update bundle must be signed with the release key; set ${missing.join(', ')}`,
        );
    return {
        keyAlias: environment[ANDROID_RELEASE_SIGNING_ENVIRONMENT.keyAlias]!,
        keystorePath: environment[ANDROID_RELEASE_SIGNING_ENVIRONMENT.keystorePath]!,
    };
};

/**
 * Parses the first line of `aapt2 dump badging`.
 */
export const parseApkBadging = (output: string): ApkBadging => {
    const match = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/mu.exec(
        output,
    );
    if (!match) throw new Error('aapt2 did not report the APK package identity');
    return { packageName: match[1], versionCode: Number(match[2]), versionName: match[3] };
};

/**
 * Every signer certificate SHA-256 from `apksigner verify --print-certs`, lowercase hex.
 */
export const parseApkSignerDigests = (output: string): string[] =>
    output
        .matchAll(/^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})$/gmu)
        .map((match) => match[1])
        .toArray();

/**
 * The certificate SHA-256 from `keytool -list -v`, normalized to apksigner's lowercase hex.
 */
export const parseKeytoolDigest = (output: string): string => {
    const digest = /^\s*SHA256: ((?:[0-9A-F]{2}:){31}[0-9A-F]{2})$/mu.exec(output)?.[1];
    if (!digest) throw new Error('keytool did not report the release certificate SHA-256');
    return digest.replaceAll(':', '').toLowerCase();
};

/**
 * The bundle must be exactly this app, at the version Desktop is releasing, signed only by the release key.
 */
export const assertUpdateApkIdentity = (options: {
    badging: ApkBadging;
    expectedVersion: string;
    expectedVersionCode: number;
    releaseDigest: string;
    signerDigests: readonly string[];
}): void => {
    const { badging } = options;
    if (badging.packageName !== 'com.caxri.mobile')
        throw new Error(`Unexpected APK package ${badging.packageName}`);
    if (
        badging.versionCode !== options.expectedVersionCode ||
        badging.versionName !== options.expectedVersion
    )
        throw new Error(
            `APK version ${badging.versionName} (${badging.versionCode}) does not match ${options.expectedVersion} (${options.expectedVersionCode}); rerun prebuild`,
        );
    if (options.signerDigests.length !== 1 || options.signerDigests[0] !== options.releaseDigest)
        throw new Error('The APK is not signed only by the configured release key');
};

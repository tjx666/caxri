import { describe, expect, it } from 'vitest';

import {
    assertUpdateApkIdentity,
    parseApkBadging,
    parseApkSignerDigests,
    parseKeytoolDigest,
    readReleaseSigning,
} from '../update-bundle-receipts';

/**
 * The React Native template's public debug certificate, which a release bundle must never carry.
 */
const DEBUG_DIGEST = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';
const RELEASE_DIGEST = '1'.repeat(64);

const badging = {
    packageName: 'com.caxri.mobile',
    versionCode: 75,
    versionName: '0.0.75',
};

describe('update bundle receipts', () => {
    it('names every missing signing variable without echoing values', () => {
        expect(() =>
            readReleaseSigning({
                CAXRI_ANDROID_KEYSTORE_PATH: '/tmp/release.jks',
                CAXRI_ANDROID_KEYSTORE_PASSWORD: 'secret-value',
            }),
        ).toThrow(/CAXRI_ANDROID_KEY_ALIAS, CAXRI_ANDROID_KEY_PASSWORD$/u);
        expect(
            readReleaseSigning({
                CAXRI_ANDROID_KEYSTORE_PATH: '/tmp/release.jks',
                CAXRI_ANDROID_KEYSTORE_PASSWORD: 'secret-value',
                CAXRI_ANDROID_KEY_ALIAS: 'caxri',
                CAXRI_ANDROID_KEY_PASSWORD: 'secret-value',
            }),
        ).toEqual({ keyAlias: 'caxri', keystorePath: '/tmp/release.jks' });
    });

    it('parses aapt2, apksigner, and keytool output', () => {
        expect(
            parseApkBadging(
                "package: name='com.caxri.mobile' versionCode='75' versionName='0.0.75' platformBuildVersionName='16'\nminSdkVersion:'24'\n",
            ),
        ).toEqual(badging);
        expect(
            parseApkSignerDigests(
                `Signer #1 certificate DN: CN=Android Debug\nSigner #1 certificate SHA-256 digest: ${DEBUG_DIGEST}\nSigner #1 certificate SHA-1 digest: ${'0'.repeat(40)}\n`,
            ),
        ).toEqual([DEBUG_DIGEST]);
        // Build Tools 37 labels each verified scheme; one key across schemes is still one signer.
        expect(
            parseApkSignerDigests(
                `V2 Signer: certificate DN: CN=Release\nV2 Signer: certificate SHA-256 digest: ${RELEASE_DIGEST}\nV2 Signer: certificate SHA-1 digest: ${'0'.repeat(40)}\nV3 Signer: certificate SHA-256 digest: ${RELEASE_DIGEST}\n`,
            ),
        ).toEqual([RELEASE_DIGEST]);
        expect(
            parseApkSignerDigests(
                `V2 Signer #1: certificate SHA-256 digest: ${RELEASE_DIGEST}\nV2 Signer #2: certificate SHA-256 digest: ${DEBUG_DIGEST}\n`,
            ),
        ).toEqual([RELEASE_DIGEST, DEBUG_DIGEST]);
        expect(
            parseKeytoolDigest(
                '\t SHA1: 5E:8F\n\t SHA256: FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C\n',
            ),
        ).toBe(DEBUG_DIGEST);
    });

    it('accepts only the release-signed APK of the expected version', () => {
        const identity = {
            badging,
            expectedVersion: '0.0.75',
            expectedVersionCode: 75,
            releaseDigest: RELEASE_DIGEST,
            signerDigests: [RELEASE_DIGEST],
        };
        expect(() => assertUpdateApkIdentity(identity)).not.toThrow();
        expect(() =>
            assertUpdateApkIdentity({ ...identity, signerDigests: [DEBUG_DIGEST] }),
        ).toThrow(/release key/u);
        expect(() =>
            assertUpdateApkIdentity({ ...identity, signerDigests: [RELEASE_DIGEST, DEBUG_DIGEST] }),
        ).toThrow(/release key/u);
        expect(() => assertUpdateApkIdentity({ ...identity, signerDigests: [] })).toThrow(
            /no signer certificate/u,
        );
        expect(() => assertUpdateApkIdentity({ ...identity, expectedVersionCode: 76 })).toThrow(
            /rerun prebuild/u,
        );
        expect(() =>
            assertUpdateApkIdentity({
                ...identity,
                badging: { ...badging, packageName: 'com.example' },
            }),
        ).toThrow(/package/u);
    });
});

import type { ConfigPlugin } from 'expo/config-plugins';
import { withAppBuildGradle } from 'expo/config-plugins';

import ANDROID_RELEASE_SIGNING_ENVIRONMENT from './android-release-signing-environment.json';

/**
 * Gradle reads these at build time, so neither the keystore path nor its passwords are written into the generated
 * native project. Without `CAXRI_ANDROID_KEYSTORE_PATH` the release variant keeps the template debug signing that local
 * emulator Acceptance builds rely on; the Desktop bundle script refuses such an APK.
 */
const environment = ANDROID_RELEASE_SIGNING_ENVIRONMENT;

const RELEASE_SIGNING_CONFIG = `        release {
            def caxriKeystorePath = System.getenv('${environment.keystorePath}')
            if (caxriKeystorePath) {
                storeFile file(caxriKeystorePath)
                storePassword System.getenv('${environment.keystorePassword}')
                keyAlias System.getenv('${environment.keyAlias}')
                keyPassword System.getenv('${environment.keyPassword}')
            }
        }
`;

const RELEASE_SIGNING_SELECTION = `signingConfig System.getenv('${environment.keystorePath}') ? signingConfigs.release : signingConfigs.debug`;

/**
 * Adds an environment-driven release signing config to the Expo template's `app/build.gradle`. This stays in the plugin
 * entrypoint because Expo transpiles that TypeScript file in isolation.
 *
 * @see https://reactnative.dev/docs/signed-apk-android
 */
export const applyAndroidReleaseSigning = (source: string): string => {
    if (source.includes(environment.keystorePath)) return source;
    const signingConfigs = /(\n {4}signingConfigs \{\n)/u;
    const releaseBuildType =
        /(\n {4}buildTypes \{[\s\S]*?\n {8}release \{[\s\S]*?)signingConfig signingConfigs\.debug/u;
    if (!signingConfigs.test(source) || !releaseBuildType.test(source))
        throw new Error('Expo app/build.gradle no longer matches the release signing template');
    return source
        .replace(signingConfigs, (match) => `${match}${RELEASE_SIGNING_CONFIG}`)
        .replace(
            releaseBuildType,
            (_match, prefix: string) => `${prefix}${RELEASE_SIGNING_SELECTION}`,
        );
};

const withAndroidReleaseSigning: ConfigPlugin = (config) =>
    withAppBuildGradle(config, (config_) => {
        config_.modResults.contents = applyAndroidReleaseSigning(config_.modResults.contents);
        return config_;
    });

export default withAndroidReleaseSigning;

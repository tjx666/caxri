import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { applyAndroidReleaseSigning } from '../with-android-release-signing';

interface ExpoPluginResolver {
    resolveConfigPluginFunction: (projectRoot: string, pluginReference: string) => unknown;
}

const projectRequire = createRequire(import.meta.url);
const expoRequire = createRequire(projectRequire.resolve('expo/package.json'));
const { resolveConfigPluginFunction } = expoRequire(
    '@expo/config-plugins/build/utils/plugin-resolver',
) as ExpoPluginResolver;
const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The relevant excerpt of Expo's generated `android/app/build.gradle`.
 */
const TEMPLATE = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
            minifyEnabled enableMinifyInReleaseBuilds
        }
    }
}
`;

describe('withAndroidReleaseSigning', () => {
    it('can be compiled and loaded by the Expo config-plugin resolver', () => {
        expect(() =>
            resolveConfigPluginFunction(mobileRoot, './plugins/with-android-release-signing'),
        ).not.toThrow();
    });

    it('selects the environment keystore for release only and is idempotent', () => {
        const signed = applyAndroidReleaseSigning(TEMPLATE);

        expect(signed).toContain(
            "def caxriKeystorePath = System.getenv('CAXRI_ANDROID_KEYSTORE_PATH')",
        );
        expect(signed).toMatch(
            /debug \{\n {12}signingConfig signingConfigs\.debug\n {8}\}\n {8}release \{\n {12}signingConfig System\.getenv\('CAXRI_ANDROID_KEYSTORE_PATH'\) \? signingConfigs\.release : signingConfigs\.debug/u,
        );
        expect(applyAndroidReleaseSigning(signed)).toBe(signed);
    });

    it('fails when the Expo template no longer has the expected shape', () => {
        expect(() => applyAndroidReleaseSigning('android {}\n')).toThrow(
            /release signing template/u,
        );
    });
});

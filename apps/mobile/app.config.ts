import type { ConfigContext, ExpoConfig } from 'expo/config';

import mobilePackage from './package.json';

/**
 * Expo evaluates this config before workspace packages are built in a clean checkout. Keep the native splash value
 * self-contained; app-config.test.ts guards its parity with the protocol theme.
 */
const MOBILE_SPLASH_BACKGROUND = '#282a36';
const MOBILE_BRAND_ICON = '../../build/icon.png';
/**
 * Match the brand icon's outer pixels so Android launcher masks retain a seamless dark edge.
 * https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/
 */
const MOBILE_ICON_BACKGROUND = '#161722';

/**
 * Derives Android's monotonically increasing `versionCode` from the release version that `release:prepare` keeps in
 * sync with Desktop, so every Desktop release ships an APK the paired phone recognizes as newer. `0.0.74` maps to 74
 * and `1.2.3` to 1_002_003; minor and patch stay below 1000 to keep the ordering exact.
 */
export const mobileVersionCode = (version: string): number => {
    const match = /^(\d{1,4})\.(\d{1,3})\.(\d{1,3})$/u.exec(version);
    if (!match) throw new Error(`Mobile version ${version} must be a plain major.minor.patch`);
    const [major, minor, patch] = match.slice(1).map(Number);
    return major * 1_000_000 + minor * 1_000 + patch;
};

export default function createExpoConfig({ config }: ConfigContext): ExpoConfig {
    return {
        ...config,
        name: 'Caxri',
        slug: 'caxri-mobile',
        version: mobilePackage.version,
        icon: MOBILE_BRAND_ICON,
        orientation: 'default',
        scheme: 'caxri',
        userInterfaceStyle: 'dark',
        ios: {
            bundleIdentifier: 'com.caxri.mobile',
            supportsTablet: true,
        },
        android: {
            package: 'com.caxri.mobile',
            versionCode: mobileVersionCode(mobilePackage.version),
            /**
             * Lets the paired-Desktop update flow hand a downloaded APK to the system package installer.
             */
            permissions: ['android.permission.REQUEST_INSTALL_PACKAGES'],
            adaptiveIcon: {
                foregroundImage: MOBILE_BRAND_ICON,
                backgroundColor: MOBILE_ICON_BACKGROUND,
            },
        },
        plugins: [
            './plugins/with-android-sdk-download-disabled',
            './plugins/with-android-gradle-build-cache',
            './plugins/with-android-bundle-environment-input',
            './plugins/with-android-mlkit-keep-rules',
            './plugins/with-android-release-signing',
            './plugins/with-mobile-network-policy',
            'expo-router',
            'expo-dev-client',
            [
                'expo-camera',
                {
                    cameraPermission: 'Allow Caxri to scan a pairing code shown on your computer.',
                },
            ],
            'expo-secure-store',
            [
                'expo-splash-screen',
                {
                    backgroundColor: MOBILE_SPLASH_BACKGROUND,
                    image: MOBILE_BRAND_ICON,
                    imageWidth: 128,
                },
            ],
        ],
        experiments: {
            typedRoutes: true,
        },
    };
}

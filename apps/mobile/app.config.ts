import type { ConfigContext, ExpoConfig } from 'expo/config';

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

export default function createExpoConfig({ config }: ConfigContext): ExpoConfig {
    return {
        ...config,
        name: 'Caxri',
        slug: 'caxri-mobile',
        version: '0.0.25',
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
            versionCode: 2,
            adaptiveIcon: {
                foregroundImage: MOBILE_BRAND_ICON,
                backgroundColor: MOBILE_ICON_BACKGROUND,
            },
        },
        plugins: [
            './plugins/with-android-sdk-download-disabled',
            './plugins/with-mobile-network-policy',
            'expo-router',
            'expo-dev-client',
            [
                'expo-camera',
                {
                    cameraPermission: 'Allow Caxri to scan a pairing code shown on your Mac.',
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

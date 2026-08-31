import type { ConfigPlugin } from 'expo/config-plugins';
import { withGradleProperties } from 'expo/config-plugins';

type GradlePropertyItem =
    | { key: string; type: 'property'; value: string }
    | { type: 'comment'; value: string }
    | { type: 'empty' };

const SDK_DOWNLOAD_PROPERTY = 'android.builder.sdkDownload';

/**
 * Prevents Android Gradle Plugin from changing the shared SDK after Caxri's read-only preflight. This stays in the
 * plugin entrypoint because Expo transpiles that TypeScript file in isolation; its generated CommonJS module cannot
 * load a sibling TypeScript-only helper.
 *
 * @see https://developer.android.com/studio/intro/update#download-with-gradle
 */
export const disableAutomaticAndroidSdkDownloads = (
    properties: GradlePropertyItem[],
): GradlePropertyItem[] => [
    ...properties.filter(
        (property) => property.type !== 'property' || property.key !== SDK_DOWNLOAD_PROPERTY,
    ),
    { key: SDK_DOWNLOAD_PROPERTY, type: 'property', value: 'false' },
];

const withAndroidSdkDownloadDisabled: ConfigPlugin = (config) =>
    withGradleProperties(config, (config_) => {
        config_.modResults = disableAutomaticAndroidSdkDownloads(config_.modResults);
        return config_;
    });

export default withAndroidSdkDownloadDisabled;

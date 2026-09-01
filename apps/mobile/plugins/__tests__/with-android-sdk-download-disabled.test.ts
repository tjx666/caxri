import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { disableAutomaticAndroidSdkDownloads } from '../with-android-sdk-download-disabled';

interface ExpoPluginResolver {
    resolveConfigPluginFunction: (projectRoot: string, pluginReference: string) => unknown;
}

const projectRequire = createRequire(import.meta.url);
const expoRequire = createRequire(projectRequire.resolve('expo/package.json'));
const { resolveConfigPluginFunction } = expoRequire(
    '@expo/config-plugins/build/utils/plugin-resolver',
) as ExpoPluginResolver;
const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('withAndroidSdkDownloadDisabled', () => {
    it('can be compiled and loaded by the Expo config-plugin resolver', () => {
        expect(() =>
            resolveConfigPluginFunction(mobileRoot, './plugins/with-android-sdk-download-disabled'),
        ).not.toThrow();
    });

    it('replaces an existing SDK download flag with a fail-closed value', () => {
        expect(
            disableAutomaticAndroidSdkDownloads([
                { type: 'comment', value: 'Keep this comment' },
                { key: 'android.builder.sdkDownload', type: 'property', value: 'true' },
            ]),
        ).toEqual([
            { type: 'comment', value: 'Keep this comment' },
            { key: 'android.builder.sdkDownload', type: 'property', value: 'false' },
        ]);
    });
});

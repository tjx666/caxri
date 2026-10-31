import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { enableGradleBuildCache } from '../with-android-gradle-build-cache';

interface ExpoPluginResolver {
    resolveConfigPluginFunction: (projectRoot: string, pluginReference: string) => unknown;
}

const projectRequire = createRequire(import.meta.url);
const expoRequire = createRequire(projectRequire.resolve('expo/package.json'));
const { resolveConfigPluginFunction } = expoRequire(
    '@expo/config-plugins/build/utils/plugin-resolver',
) as ExpoPluginResolver;
const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('withAndroidGradleBuildCache', () => {
    it('can be compiled and loaded by the Expo config-plugin resolver', () => {
        expect(() =>
            resolveConfigPluginFunction(mobileRoot, './plugins/with-android-gradle-build-cache'),
        ).not.toThrow();
    });

    it('replaces an existing build cache flag with an enabled one', () => {
        expect(
            enableGradleBuildCache([
                { type: 'comment', value: 'Keep this comment' },
                { key: 'org.gradle.caching', type: 'property', value: 'false' },
            ]),
        ).toEqual([
            { type: 'comment', value: 'Keep this comment' },
            { key: 'org.gradle.caching', type: 'property', value: 'true' },
        ]);
    });
});

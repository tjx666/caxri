import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { applyAndroidBundleEnvironmentInput } from '../with-android-bundle-environment-input';

interface ExpoPluginResolver {
    resolveConfigPluginFunction: (projectRoot: string, pluginReference: string) => unknown;
}

const projectRequire = createRequire(import.meta.url);
const expoRequire = createRequire(projectRequire.resolve('expo/package.json'));
const { resolveConfigPluginFunction } = expoRequire(
    '@expo/config-plugins/build/utils/plugin-resolver',
) as ExpoPluginResolver;
const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));

describe('withAndroidBundleEnvironmentInput', () => {
    it('can be compiled and loaded by the Expo config-plugin resolver', () => {
        expect(() =>
            resolveConfigPluginFunction(
                mobileRoot,
                './plugins/with-android-bundle-environment-input',
            ),
        ).not.toThrow();
    });

    it('declares the EXPO_PUBLIC_ values as bundle task inputs once', () => {
        const source = applyAndroidBundleEnvironmentInput('android {\n}\n');

        expect(source).toMatch(
            /tasks\.matching \{ it\.name ==~ \/createBundle\.\+JsAndAssets\/ \}\.configureEach \{\n {4}inputs\.property\('caxriExpoPublicEnvironment', caxriExpoPublicEnvironment\)/u,
        );
        expect(source).toContain("it.key.startsWith('EXPO_PUBLIC_')");
        expect(applyAndroidBundleEnvironmentInput(source)).toBe(source);
    });

    it('declares workspace package sources as bundle task inputs', () => {
        const source = applyAndroidBundleEnvironmentInput('android {\n}\n');

        expect(source).toContain("new File(rootProject.projectDir, '../../../packages')");
        expect(source).toContain("['src', 'dist'].each");
        expect(source).toContain('inputs.files(fileTree(dir: new File(packageDir, sub)');
        expect(source).toContain("inputs.files(new File(packageDir, 'package.json'))");
        expect(source).toContain('**/__tests__/**');
    });
});

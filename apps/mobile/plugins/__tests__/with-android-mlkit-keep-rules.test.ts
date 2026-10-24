import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { appendMlkitKeepRules } from '../with-android-mlkit-keep-rules';

interface ExpoPluginResolver {
    resolveConfigPluginFunction: (projectRoot: string, pluginReference: string) => unknown;
}

const projectRequire = createRequire(import.meta.url);
const expoRequire = createRequire(projectRequire.resolve('expo/package.json'));
const { resolveConfigPluginFunction } = expoRequire(
    '@expo/config-plugins/build/utils/plugin-resolver',
) as ExpoPluginResolver;
const mobileRoot = fileURLToPath(new URL('../..', import.meta.url));

const keepRule =
    '-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }';

describe('withAndroidMlkitKeepRules', () => {
    it('can be compiled and loaded by the Expo config-plugin resolver', () => {
        expect(() =>
            resolveConfigPluginFunction(mobileRoot, './plugins/with-android-mlkit-keep-rules'),
        ).not.toThrow();
    });

    it('keeps the ML Kit registrar constructors after the existing rules', () => {
        const rules = appendMlkitKeepRules('# react-native-reanimated\n-keep class a.** { *; }\n');
        expect(rules.startsWith('# react-native-reanimated\n-keep class a.** { *; }\n')).toBe(true);
        expect(rules).toContain(keepRule);
    });

    it('stays idempotent across repeated prebuilds', () => {
        const once = appendMlkitKeepRules('-keep class a.** { *; }\n');
        expect(appendMlkitKeepRules(once)).toBe(once);
        expect(once.split(keepRule)).toHaveLength(2);
    });
});

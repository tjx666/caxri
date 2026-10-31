import type { ConfigPlugin } from 'expo/config-plugins';
import { withAppBuildGradle } from 'expo/config-plugins';

const MARKER = 'caxriExpoPublicEnvironment';

/**
 * Expo inlines every `EXPO_PUBLIC_*` value into the JS bundle, but React Native's `createBundle<Variant>JsAndAssets`
 * task does not declare them as inputs. An incremental release build therefore kept a bundle compiled for another
 * Acceptance fault or without the Acceptance flag, reporting the task `UP-TO-DATE`. Declaring the values as an input
 * makes Gradle rerun the bundle exactly when one changes.
 */
const BUNDLE_ENVIRONMENT_INPUT = `
// Caxri: rebundle when an inlined EXPO_PUBLIC_* value changes (see plugins/with-android-bundle-environment-input.ts).
def ${MARKER} = System.getenv().findAll { it.key.startsWith('EXPO_PUBLIC_') }.sort().toString()
tasks.matching { it.name ==~ /createBundle.+JsAndAssets/ }.configureEach {
    inputs.property('${MARKER}', ${MARKER})
}
`;

/**
 * Appends the bundle input declaration to the Expo template's `app/build.gradle`. This stays in the plugin entrypoint
 * because Expo transpiles that TypeScript file in isolation.
 */
export const applyAndroidBundleEnvironmentInput = (source: string): string =>
    source.includes(MARKER) ? source : `${source.trimEnd()}\n${BUNDLE_ENVIRONMENT_INPUT}`;

const withAndroidBundleEnvironmentInput: ConfigPlugin = (config) =>
    withAppBuildGradle(config, (config_) => {
        config_.modResults.contents = applyAndroidBundleEnvironmentInput(
            config_.modResults.contents,
        );
        return config_;
    });

export default withAndroidBundleEnvironmentInput;

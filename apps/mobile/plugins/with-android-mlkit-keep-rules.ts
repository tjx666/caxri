import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ConfigPlugin } from 'expo/config-plugins';
import { withDangerousMod } from 'expo/config-plugins';

const RULES_BEGIN = '# @caxri/mlkit-component-registrars begin';
const RULES_END = '# @caxri/mlkit-component-registrars end';

/**
 * ML Kit discovers its components from manifest metadata and instantiates each `ComponentRegistrar` through its no-arg
 * constructor by reflection. R8 full mode, which Expo's template enables for every release build, keeps the class names
 * but removes those constructors, so `BarcodeScanning.getClient` fails and expo-camera swallows the error: the scan
 * screen shows the camera yet never reports a code, and photo scanning finds nothing. Keeping the constructors restores
 * barcode scanning in release builds. This stays in the plugin entrypoint because Expo transpiles that TypeScript file
 * in isolation; its generated CommonJS module cannot load a sibling TypeScript-only helper.
 *
 * @see https://r8.googlesource.com/r8/+/refs/heads/main/compatibility-faq.md#r8-full-mode
 */
const MLKIT_KEEP_RULES = [
    RULES_BEGIN,
    '-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }',
    RULES_END,
].join('\n');

/**
 * Replaces any earlier copy of the block so repeated prebuilds stay idempotent.
 */
export const appendMlkitKeepRules = (rules: string): string => {
    const begin = rules.indexOf(RULES_BEGIN);
    const end = rules.indexOf(RULES_END);
    const base =
        begin !== -1 && end > begin
            ? rules.slice(0, begin) + rules.slice(end + RULES_END.length)
            : rules;
    return `${base.trimEnd()}\n\n${MLKIT_KEEP_RULES}\n`;
};

const withAndroidMlkitKeepRules: ConfigPlugin = (config) =>
    withDangerousMod(config, [
        'android',
        async (config_) => {
            const rulesPath = path.join(
                config_.modRequest.platformProjectRoot,
                'app',
                'proguard-rules.pro',
            );
            await writeFile(rulesPath, appendMlkitKeepRules(await readFile(rulesPath, 'utf8')));
            return config_;
        },
    ]);

export default withAndroidMlkitKeepRules;

import { join } from 'node:path';

import { assertBuildOutputsFresh } from '@caxri/system';

import { runChildProcess } from '../../../../scripts/exec';

export const RELEASE_APK = 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk';

/**
 * Sources the release APK bundles. One that changed after the APK was built means the image shows an outdated phone
 * app, which may also speak an older mobile protocol than the Server it pairs with (a renamed subscription kind).
 */
export const MOBILE_APK_INPUTS = [
    'apps/mobile/app',
    'apps/mobile/app.config.ts',
    'apps/mobile/package.json',
    'apps/mobile/plugins',
    'apps/mobile/src',
    'packages/mobile-transport/package.json',
    'packages/mobile-transport/src',
    'packages/protocol/package.json',
    'packages/protocol/src',
    'packages/utils/package.json',
    'packages/utils/src',
];

const MOBILE_APK_INPUT_EXTENSIONS = new Set([
    '.js',
    '.json',
    '.png',
    '.svg',
    '.ts',
    '.tsx',
    '.ttf',
]);

/**
 * Rejects a missing release APK, or one older than any mobile source, so a capture never pairs an outdated phone app.
 */
export async function assertReleaseApkFresh(root: string): Promise<void> {
    await assertBuildOutputsFresh({
        inputPaths: MOBILE_APK_INPUTS.map((path) => join(root, path)),
        outputPaths: [join(root, RELEASE_APK)],
        watchedDirectoryExtensions: MOBILE_APK_INPUT_EXTENSIONS,
        staleMessage:
            'The release APK is missing or older than the mobile sources; rerun with --build-apk',
    });
}

/**
 * Builds the release APK the way Android Acceptance does: a clean native prebuild, then the release variant.
 */
export async function buildReleaseApk(root: string): Promise<void> {
    for (const arguments_ of [
        ['run', '--cwd', 'apps/mobile', 'prebuild:android', '--', '--clean'],
        ['run', '--cwd', 'apps/mobile', 'android', '--', '--build-only', '--variant', 'release'],
    ]) {
        // eslint-disable-next-line no-await-in-loop -- the release build needs the native project prebuild writes
        const code = await runChildProcess('bun', arguments_, { cwd: root, stdio: 'inherit' });
        if (code !== 0)
            throw new Error(`bun ${arguments_.join(' ')} failed with exit code ${code}`);
    }
}

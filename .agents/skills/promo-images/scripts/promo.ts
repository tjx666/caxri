/**
 * Generates one promo image from a scene: captures the desktop app and the paired Android app playing the scene, then
 * composes both captures with the scene's copy.
 *
 * Usage:
 *
 * ```sh
 * bun run .agents/skills/promo-images/scripts/promo.ts --scene .agents/skills/promo-images/scenes/readme-hero.json \
 *     --android-serial emulator-5560 --out docs/assets/readme-hero.png
 * ```
 *
 * Needs a fresh `bun run build`, a release APK built from the current mobile sources (`--build-apk` builds it), and a
 * running disposable emulator: the run reinstalls Caxri there and clears its data before and after. The captures, the
 * layout document and Playwright's output stay under `.records/promo-images/<scene>-<time>/`; only `--out` is meant to
 * be published, and it is replaced only when the new image passes its checks.
 */
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { execFileAsync, runChildProcess } from '../../../../scripts/exec';
import { showDemoStatusBar } from './promo-android';
import { assertReleaseApkFresh, buildReleaseApk, RELEASE_APK } from './promo-apk';
import { composePromoImage } from './promo-image';
import { DESKTOP_CAPTURE_SCALE, loadPromoScene } from './promo-scene';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const adb = join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
const MOBILE_PACKAGE = 'com.caxri.mobile';
const ANIMATION_SCALES = [
    'window_animation_scale',
    'transition_animation_scale',
    'animator_duration_scale',
];

function device(serial: string) {
    return async (arguments_: string[]): Promise<void> => {
        await execFileAsync(adb, ['-s', serial, ...arguments_], { timeout: 120_000 });
    };
}

/**
 * Turns animations off and puts the status bar in demo mode, so the phone capture shows nothing of the emulator's real
 * state.
 */
async function prepareAndroid(run: ReturnType<typeof device>, serial: string): Promise<void> {
    for (const name of ANIMATION_SCALES) {
        // eslint-disable-next-line no-await-in-loop -- three settings on one device
        await run(['shell', 'settings', 'put', 'global', name, '0']);
    }
    await run(['shell', 'settings', 'put', 'global', 'sysui_demo_allowed', '1']);
    await showDemoStatusBar(serial);
}

async function restoreAndroid(run: ReturnType<typeof device>): Promise<void> {
    await run([
        'shell',
        'am',
        'broadcast',
        '-a',
        'com.android.systemui.demo',
        '-e',
        'command',
        'exit',
    ]);
    for (const name of ANIMATION_SCALES) {
        // eslint-disable-next-line no-await-in-loop -- three settings on one device
        await run(['shell', 'settings', 'put', 'global', name, '1']);
    }
    // The paired app holds this run's mobile credentials; they must not outlive it.
    await run(['shell', 'pm', 'clear', MOBILE_PACKAGE]);
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            'scene': { type: 'string' },
            'android-serial': { type: 'string' },
            'out': { type: 'string' },
            'build-apk': { type: 'boolean', default: false },
        },
        strict: true,
    });
    const {
        'scene': scenePath,
        'android-serial': serial,
        out,
        'build-apk': shouldBuildApk,
    } = values;
    if (!scenePath || !serial || !out)
        throw new Error(
            'Required options: --scene <json> --android-serial <emulator-N> --out <png> [--build-apk]',
        );
    if (!/^emulator-\d+$/u.test(serial)) {
        throw new Error(
            '--android-serial must name a disposable emulator such as emulator-5560: the run clears Caxri data on it',
        );
    }
    // A broken scene, or a desktop too small for its canvas, fails here before anything is launched. Whether the phone
    // capture fits needs its real size, so composing checks that.
    const { scene } = await loadPromoScene(scenePath);
    if (shouldBuildApk) await buildReleaseApk(repoRoot);
    await assertReleaseApkFresh(repoRoot);
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-');
    const runDirectory = join(repoRoot, '.records', 'promo-images', `${scene.name}-${stamp}`);
    await mkdir(runDirectory, { recursive: true });

    const run = device(serial);
    try {
        await run(['install', '-r', join(repoRoot, RELEASE_APK)]);
        await run(['shell', 'pm', 'clear', MOBILE_PACKAGE]);
        await prepareAndroid(run, serial);
        const code = await runChildProcess(
            'bunx',
            [
                '--bun',
                'playwright',
                'test',
                '--config',
                join(import.meta.dirname, 'promo-playwright.config.ts'),
            ],
            {
                cwd: repoRoot,
                stdio: 'inherit',
                env: {
                    ...process.env,
                    CAXRI_PROMO_SCENE: resolve(scenePath),
                    CAXRI_PROMO_CAPTURE_DIR: runDirectory,
                    CAXRI_PROMO_ANDROID_SERIAL: serial,
                },
            },
        );
        if (code !== 0)
            throw new Error(`The capture failed with exit code ${code}; see its output above`);
    } finally {
        await restoreAndroid(run);
    }

    const outPath = resolve(out);
    const result = await composePromoImage({
        layout: scene.layout,
        canvas: scene.canvas,
        headline: scene.copy.headline,
        subhead: scene.copy.subhead,
        desktopPath: join(runDirectory, 'desktop.png'),
        mobilePath: join(runDirectory, 'mobile.png'),
        desktopScale: DESKTOP_CAPTURE_SCALE,
        outPath,
        htmlPath: join(runDirectory, 'layout.html'),
    });
    console.log(
        `ok - ${outPath} (${result.width}x${result.height}, ${Math.round(result.png.length / 1024)} KiB); captures in ${runDirectory}`,
    );
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}

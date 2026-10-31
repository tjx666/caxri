import { join } from 'node:path';

import { ANDROID_BUILD_SLOT_COUNT, withAndroidBuildSlot } from './mobile-android-build-slot';
import {
    androidPrebuildInputFingerprint,
    decideAndroidPrebuild,
    hashAndroidNativeProject,
    parseAndroidEmulatorAbi,
    readAndroidPrebuildStamp,
    writeAndroidPrebuildStamp,
} from './mobile-android-native-project';

interface AndroidReleaseBuildOptions {
    adbRead: (arguments_: string[]) => string;
    environment: NodeJS.ProcessEnv;
    read: (command: string, arguments_: string[]) => string;
    root: string;
    run: (
        command: string,
        arguments_: string[],
        environment: NodeJS.ProcessEnv,
        timeoutMs: number,
    ) => void;
    timeouts: { build: number; release: number };
    /**
     * The latest moment the build may still be waiting for a machine-wide build slot.
     */
    waitDeadlineMs: number;
}

/**
 * Regenerates `apps/mobile/android` only when a prebuild input changed or the generated sources were modified since
 * this runner wrote them. `expo prebuild` deletes `android/.gradle` even without `--clean`, so running it every round
 * discarded Gradle's execution history and recompiled every native module.
 */
async function prepareAndroidNativeProject(options: AndroidReleaseBuildOptions): Promise<void> {
    const androidDirectory = join(options.root, 'apps/mobile/android');
    const inputs = androidPrebuildInputFingerprint((path) =>
        options.read('git', ['rev-parse', `HEAD:${path}`]).trim(),
    );
    const stamp = await readAndroidPrebuildStamp(androidDirectory);
    const project = stamp ? await hashAndroidNativeProject(androidDirectory) : undefined;
    const decision = decideAndroidPrebuild(stamp, { inputs, project });
    console.info(
        decision.action === 'reuse'
            ? 'Android native project: reused'
            : `Android native project: regenerating (${decision.reason})`,
    );
    if (decision.action === 'reuse') return;
    options.run(
        'bun',
        ['run', '--cwd', 'apps/mobile', 'expo', 'prebuild', '--platform', 'android', '--clean'],
        { ...options.environment, EXPO_NO_GIT_STATUS: '1' },
        options.timeouts.build,
    );
    await writeAndroidPrebuildStamp(androidDirectory, inputs);
}

/**
 * Builds the release APK for the selected emulator: the workspace packages once, the native project when it is stale,
 * then a Gradle build of only the emulator's ABI inside a machine-wide build slot.
 */
export async function buildAndroidAcceptanceRelease(
    options: AndroidReleaseBuildOptions,
): Promise<void> {
    // Built once here: the `prebuild:android` and `android` package scripts would each rebuild it.
    options.run(
        'bun',
        ['run', '--cwd', 'apps/mobile', 'build:dependencies'],
        options.environment,
        options.timeouts.build,
    );
    await prepareAndroidNativeProject(options);
    const abi = parseAndroidEmulatorAbi(
        options.adbRead(['shell', 'getprop', 'ro.product.cpu.abi']),
    );
    await withAndroidBuildSlot(
        options.root,
        () => {
            options.run(
                'bun',
                [
                    'apps/mobile/scripts/android-build.ts',
                    '--build-only',
                    '--variant',
                    'release',
                    '--abi',
                    abi,
                ],
                options.environment,
                options.timeouts.release,
            );
        },
        {
            deadlineMs: options.waitDeadlineMs,
            onWait: () => {
                console.info(
                    `Waiting for one of ${ANDROID_BUILD_SLOT_COUNT} Android Acceptance build slots held by other worktrees`,
                );
            },
        },
    );
}

#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    markCaseLifecycleReady,
} from '../.agents/skills/acceptance/scripts/case-lifecycle';
import { loadAcceptanceCasePlan } from '../.agents/skills/acceptance/scripts/report';
import { repoContext, withRepoLock } from '../.agents/skills/switch-worktree/scripts/repo';
import { assertAndroidResponsive } from './mobile-acceptance-anr';
import { mobileAcceptanceFaultEnvironment } from './mobile-acceptance-fault';
import {
    cleanupFixtureImeWithRetry,
    markMobileFixtureImeRestored,
    prepareMobileFixtureIme,
} from './mobile-acceptance-ime';
import { prepareMobileAppLocale } from './mobile-acceptance-locale';
import { prepareMobileLiveMotion, withMobileReducedMotion } from './mobile-acceptance-motion';
import type { MobileAcceptanceArtifact } from './mobile-acceptance-runtime';
import {
    assertMobileAcceptanceSourceIdentity,
    captureMobileAcceptanceCommand,
    clearMobileAcceptanceCaseArtifacts,
    collectMobileAcceptanceArtifacts,
    createMobileAcceptanceArtifact,
    interruptAndroidScreenrecord,
    recordAndroidSetupBlockedCase,
    runMobileAcceptanceCommand,
    startMobileAcceptanceRecording,
    writeMobileAcceptanceArtifact,
    writeMobileAcceptanceReceipt,
} from './mobile-acceptance-runtime';
import { executeAndroidBuiltInScenario } from './mobile-android-built-in-scenarios';
import type { MobileAndroidAcceptanceCaseId } from './mobile-android-cases';
import {
    mobileAndroidAcceptanceCase,
    parseMobileAndroidCaseIds,
    shouldCaptureAdapterScreenshot,
    shouldCollectAndroidVideo,
} from './mobile-android-cases';
import { createAndroidAcceptanceDesktopLease } from './mobile-android-desktop-lease';
import {
    androidNativeInitLogcatArguments,
    findAndroidNativeInitFailures,
    parseAndroidPackageUid,
} from './mobile-android-native-init';
import { readAndroidScenarioArtifacts } from './mobile-android-scenario-artifacts';

const root = resolve(import.meta.dirname, '..');
const adb = join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
const releaseApk = join(root, 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk');
const serial = (() => {
    const value = process.env.CAXRI_MOBILE_ACCEPTANCE_SERIAL;
    if (!value || !/^emulator-\d+$/u.test(value)) {
        throw new Error('CAXRI_MOBILE_ACCEPTANCE_SERIAL must name one disposable Android emulator');
    }
    return value;
})();
const reportDirectory = (() => {
    const value = process.env.CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR;
    if (!value) throw new Error('CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR is required');
    return value;
})();
const caseIds = parseMobileAndroidCaseIds(
    process.env.CAXRI_MOBILE_ACCEPTANCE_CASE_IDS ?? process.env.CAXRI_MOBILE_ACCEPTANCE_CASE_ID,
);

const OVERALL_TIMEOUT_MS = 90 * 60_000;
const CLEANUP_RESERVE_MS = 2 * 60_000;
const BUILD_TIMEOUT_MS = 12 * 60_000;
/**
 * The Gradle release build gets its own budget. After a React Native or Android Gradle Plugin upgrade the first build
 * compiles every native module from scratch: one cold build was killed in R8 at 12 minutes, while the warm rebuild took
 * under 4. A fresh worktree's first build on a loaded host (several emulators running) then also outran 30 minutes and
 * took about 12 once warm, so the budget leaves room for that; the overall deadline still bounds the whole run.
 */
const ANDROID_RELEASE_BUILD_TIMEOUT_MS = 45 * 60_000;
const E2E_TIMEOUT_MS = 8 * 60_000;
const DEVICE_TIMEOUT_MS = 30_000;
const SOURCE_TIMEOUT_MS = 10_000;
const overallDeadlineMs = Date.now() + OVERALL_TIMEOUT_MS;
const activeDeadlineMs = overallDeadlineMs - CLEANUP_RESERVE_MS;

const run = (
    command: string,
    arguments_: string[],
    timeoutMs: number,
    environment = process.env,
    deadlineMs = activeDeadlineMs,
): string =>
    runMobileAcceptanceCommand({
        arguments: arguments_,
        command,
        cwd: root,
        deadlineMs,
        environment,
        timeoutMs,
    });

const read = (
    command: string,
    arguments_: string[],
    timeoutMs: number,
    deadlineMs = activeDeadlineMs,
) =>
    runMobileAcceptanceCommand({
        arguments: arguments_,
        captureOutput: true,
        command,
        cwd: root,
        deadlineMs,
        timeoutMs,
    });

const adbRun = (arguments_: string[], deadlineMs = activeDeadlineMs): string =>
    run(adb, ['-s', serial, ...arguments_], DEVICE_TIMEOUT_MS, process.env, deadlineMs);
const adbRead = (arguments_: string[], deadlineMs = activeDeadlineMs): string =>
    read(adb, ['-s', serial, ...arguments_], DEVICE_TIMEOUT_MS, deadlineMs);

async function waitForCheck(checkId: string, timeoutMs = DEVICE_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    do {
        const source = read(
            'bun',
            ['run', 'apps/mobile/scripts/android-device.ts', 'semantics', '--serial', serial],
            DEVICE_TIMEOUT_MS,
        );
        const checks = (JSON.parse(source) as { checks: Array<{ checkId: string }> }).checks;
        if (checks.some((check) => check.checkId === checkId)) return;
        // eslint-disable-next-line no-await-in-loop -- each sanitized observation follows the prior device state.
        await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new Error(`Android Acceptance did not reach ${checkId}`);
}

function packageIdentity(): { debuggable: boolean; versionName: string } {
    const source = adbRead(['shell', 'dumpsys', 'package', 'com.caxri.mobile']);
    return {
        debuggable: /\bDEBUGGABLE\b/u.test(source),
        versionName: /versionName=(\S+)/u.exec(source)?.[1] ?? 'unavailable',
    };
}

function semanticCheckIds(): string[] {
    const source = read(
        'bun',
        ['run', 'apps/mobile/scripts/android-device.ts', 'semantics', '--serial', serial],
        DEVICE_TIMEOUT_MS,
    );
    return (JSON.parse(source) as { checks: Array<{ checkId: string }> }).checks
        .map(({ checkId }) => checkId)
        .toSorted((left, right) => left.localeCompare(right));
}

async function writeScenarioReceipt(
    caseId: MobileAndroidAcceptanceCaseId,
    value: Record<string, unknown>,
): Promise<void> {
    await writeMobileAcceptanceReceipt(join(reportDirectory, 'assets', `${caseId}-scenario.txt`), {
        ...value,
        caseId,
        schemaVersion: 1,
    });
}

async function executeScenario(
    caseId: MobileAndroidAcceptanceCaseId,
    launchId: string,
    remoteVideoPath: string,
    sourceCommit: string,
): Promise<void> {
    await executeAndroidBuiltInScenario(
        {
            adbRead,
            adbRun: (arguments_) => adbRun(arguments_),
            executePlaywrightScenario: () =>
                executePlaywrightScenario(caseId, launchId, remoteVideoPath, sourceCommit),
            packageIdentity,
            semanticCheckIds,
            serial,
            tap: (checkId) =>
                run(
                    'bun',
                    [
                        'run',
                        'apps/mobile/scripts/android-device.ts',
                        'tap',
                        '--serial',
                        serial,
                        '--check-id',
                        checkId,
                    ],
                    DEVICE_TIMEOUT_MS,
                ),
            waitForCheck: (checkId) => waitForCheck(checkId),
            writeScenarioReceipt: (value) => writeScenarioReceipt(caseId, value),
        },
        caseId,
        { launchId, sourceCommit },
    );
    const uid = parseAndroidPackageUid(
        adbRead(['shell', 'cmd', 'package', 'list', 'packages', '-U', 'com.caxri.mobile']),
    );
    const failures = findAndroidNativeInitFailures(adbRead(androidNativeInitLogcatArguments(uid)));
    if (failures.length > 0)
        throw new Error(`Android release build failed to instantiate ${failures.join(', ')}`);
}

function executePlaywrightScenario(
    caseId: MobileAndroidAcceptanceCaseId,
    launchId: string,
    remoteVideoPath: string,
    sourceCommit: string,
): void {
    const assetsDirectory = join(reportDirectory, 'assets');
    const artifactManifest = join(assetsDirectory, `${caseId}-artifact-manifest.json`);
    const scenarioReceipt = join(assetsDirectory, `${caseId}-scenario.txt`);
    const environment = {
        ...process.env,
        CAXRI_MOBILE_ACCEPTANCE_ARTIFACT_MANIFEST: artifactManifest,
        CAXRI_MOBILE_ACCEPTANCE_ASSETS_DIR: assetsDirectory,
        CAXRI_MOBILE_ACCEPTANCE_BUILD_MODE: 'release',
        CAXRI_MOBILE_ACCEPTANCE_CASE_ID: caseId,
        CAXRI_MOBILE_ACCEPTANCE_LAUNCH_ID: launchId,
        CAXRI_MOBILE_ACCEPTANCE_SCENARIO_RECEIPT: scenarioReceipt,
        CAXRI_MOBILE_ACCEPTANCE_SERIAL: serial,
        CAXRI_MOBILE_ACCEPTANCE_SOURCE_COMMIT: sourceCommit,
        ...(mobileAndroidAcceptanceCase(caseId).recordingOwner === 'scenario' && {
            CAXRI_MOBILE_ACCEPTANCE_REMOTE_VIDEO_PATH: remoteVideoPath,
        }),
    };
    run(
        'bunx',
        ['playwright', 'test', 'e2e/mobile-acceptance-scenarios.e2e.ts', '--workers=1'],
        E2E_TIMEOUT_MS,
        environment,
    );
}

async function executeCase(
    caseId: MobileAndroidAcceptanceCaseId,
    sourceCommit: string,
    apkSha256: string,
): Promise<void> {
    const planned = await loadAcceptanceCasePlan(reportDirectory, caseId);
    if (
        planned.commit !== sourceCommit ||
        planned.item.surface !== 'mobile' ||
        planned.item.mobileDevice?.platform !== 'android' ||
        planned.item.mobileDevice.deviceId !== serial ||
        planned.item.stateIsolation.mode !== 'isolated'
    ) {
        throw new Error(`Android Acceptance case ${caseId} does not match the frozen target`);
    }
    await clearMobileAcceptanceCaseArtifacts(reportDirectory, caseId);
    const definition = mobileAndroidAcceptanceCase(caseId);
    const profileIdentity = `android-emulator:${serial}:com.caxri.mobile:${randomUUID()}`;
    const launchId = await beginCaseLifecycle(reportDirectory, {
        caseId,
        profileIdentity,
        stateIsolation: planned.item.stateIsolation,
    });
    const screenshotPath = join(reportDirectory, 'assets', `${caseId}-android.png`);
    const videoPath = join(reportDirectory, 'assets', `${caseId}-android.mp4`);
    const remoteVideoPath = `/data/local/tmp/caxri-acceptance-${process.pid}-${caseId}.mp4`;
    const artifacts: MobileAcceptanceArtifact[] = [];
    let failure: unknown;
    let isLifecycleReady = false;
    let isCleanupCompleted = false;
    let recording: Awaited<ReturnType<typeof startMobileAcceptanceRecording>> | undefined;
    /**
     * Restores of this case's own device settings, newest first, run before the app data is cleared.
     */
    const caseSettingRestores: Array<() => void> = [];
    try {
        assertAndroidResponsive(serial, adbRead);
        adbRun(['shell', 'pm', 'clear', 'com.caxri.mobile']);
        // The native-init guard reads only warnings logged after this point.
        adbRun(['logcat', '-c']);
        // The same commands later restore the settings during cleanup, which may use the cleanup reserve.
        const deviceCommands = {
            readDevice: adbRead,
            runDevice: (arguments_: string[]) => adbRun(arguments_, overallDeadlineMs),
        };
        // Both settings are read when the app starts, so they land after the clear and before the scenario launches it.
        if (definition.motion === 'live')
            caseSettingRestores.unshift(prepareMobileLiveMotion(serial, deviceCommands));
        if (definition.appLocale)
            caseSettingRestores.unshift(
                prepareMobileAppLocale(serial, deviceCommands, definition.appLocale),
            );
        await markCaseLifecycleReady(reportDirectory, { caseId, launchId });
        isLifecycleReady = true;
        if (definition.media.includes('video') && definition.recordingOwner === 'adapter') {
            recording = await startMobileAcceptanceRecording({
                arguments: [
                    '-s',
                    serial,
                    'shell',
                    'screenrecord',
                    '--bit-rate',
                    '8000000',
                    '--time-limit',
                    '180',
                    remoteVideoPath,
                ],
                command: adb,
                cwd: root,
                interrupt: () => {
                    interruptAndroidScreenrecord({
                        adb,
                        cwd: root,
                        serial,
                        timeoutMs: DEVICE_TIMEOUT_MS,
                    });
                },
            });
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        await executeScenario(caseId, launchId, remoteVideoPath, sourceCommit);
        const scenarioArtifacts = await readAndroidScenarioArtifacts(reportDirectory, caseId);
        for (const artifactPath of scenarioArtifacts) {
            // Sequential hashing preserves frozen artifact order and bounds device evidence memory.
            // eslint-disable-next-line no-await-in-loop
            const artifact = await createMobileAcceptanceArtifact(
                join(reportDirectory, artifactPath),
                {
                    path: artifactPath,
                    source: 'android-framebuffer',
                    type: 'screenshot',
                },
            );
            artifacts.push(artifact);
        }
    } catch (error) {
        failure = error;
    } finally {
        const activeRecording = recording;
        const collected = await collectMobileAcceptanceArtifacts({
            captureRecording: shouldCollectAndroidVideo(caseId, failure === undefined)
                ? async () => {
                      await activeRecording?.stop();
                      run(
                          adb,
                          ['-s', serial, 'pull', remoteVideoPath, videoPath],
                          DEVICE_TIMEOUT_MS,
                          process.env,
                          overallDeadlineMs,
                      );
                      return createMobileAcceptanceArtifact(videoPath, {
                          path: `assets/${caseId}-android.mp4`,
                          source: 'android-framebuffer',
                          type: 'video',
                      });
                  }
                : undefined,
            captureScreenshot: shouldCaptureAdapterScreenshot(caseId, isLifecycleReady)
                ? async () => {
                      const screenshot = captureMobileAcceptanceCommand({
                          arguments: ['-s', serial, 'exec-out', 'screencap', '-p'],
                          command: adb,
                          cwd: root,
                          deadlineMs: overallDeadlineMs,
                          timeoutMs: DEVICE_TIMEOUT_MS,
                      });
                      await writeMobileAcceptanceArtifact(screenshotPath, screenshot);
                      return createMobileAcceptanceArtifact(screenshotPath, {
                          path: `assets/${caseId}-android.png`,
                          source: 'android-framebuffer',
                          type: 'screenshot',
                      });
                  }
                : undefined,
            failure,
        });
        failure = collected.failure;
        artifacts.push(...collected.artifacts);
        try {
            adbRun(['shell', 'rm', '-f', remoteVideoPath], overallDeadlineMs);
        } catch (error) {
            failure ??= error;
        }
        for (const restore of caseSettingRestores) {
            try {
                restore();
            } catch (error) {
                failure ??= error;
            }
        }
        try {
            adbRun(['shell', 'pm', 'clear', 'com.caxri.mobile'], overallDeadlineMs);
            isCleanupCompleted = true;
        } catch (error) {
            failure ??= error;
        }
        try {
            await completeCaseLifecycle(reportDirectory, {
                caseId,
                cleanupCompleted: isCleanupCompleted,
                cleanupRequested: true,
                launchId,
            });
        } catch (error) {
            failure ??= error;
        }
    }

    const status = failure ? (isLifecycleReady ? 'failed' : 'blocked') : 'passed';
    await writeMobileAcceptanceReceipt(
        join(reportDirectory, 'assets', `${caseId}-mobile-device.json`),
        {
            appId: 'com.caxri.mobile',
            artifacts,
            build: { identity: apkSha256, mode: 'release' },
            caseId,
            cleanup: {
                appData: isCleanupCompleted ? 'cleared' : 'preserved',
                desktopProfile: definition.desktopProfile,
                fixtureIme: 'pending',
            },
            device: { id: serial, kind: 'emulator', platform: 'android' },
            launchId,
            outcome: status === 'passed' ? definition.scenario : 'acceptance-case-did-not-pass',
            schemaVersion: 1,
            sourceCommit,
            status,
        },
    );
    if (failure) throw failure instanceof Error ? failure : new Error('Android Acceptance failed');
}

const plannedCases = await Promise.all(
    caseIds.map((caseId) => loadAcceptanceCasePlan(reportDirectory, caseId)),
);
const sourceCommit = read('git', ['rev-parse', 'HEAD'], SOURCE_TIMEOUT_MS).trim().toLowerCase();
const sourceStatus = read(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    SOURCE_TIMEOUT_MS,
);
for (const [index, planned] of plannedCases.entries()) {
    const caseId = caseIds[index];
    assertMobileAcceptanceSourceIdentity({
        actualCommit: sourceCommit,
        plannedCommit: planned.commit,
        status: sourceStatus,
    });
    if (
        planned.item.surface !== 'mobile' ||
        planned.item.mobileDevice?.platform !== 'android' ||
        planned.item.mobileDevice.deviceId !== serial ||
        planned.item.stateIsolation.mode !== 'isolated'
    ) {
        throw new Error(`Android Acceptance case ${caseId} does not match the frozen target`);
    }
}

await withRepoLock(
    await repoContext(root),
    async () => {
        const acceptanceBuildEnvironment = {
            ...process.env,
            EXPO_PUBLIC_CAXRI_ACCEPTANCE: '1',
            ...mobileAcceptanceFaultEnvironment(caseIds),
        };
        let setupFailure: unknown;
        let apkSha256: string | undefined;
        let cleanupFixtureIme: (() => Promise<void>) | undefined;
        const desktopLease = createAndroidAcceptanceDesktopLease(root);
        try {
            // Before the half-hour build, so a hung emulator fails in seconds.
            assertAndroidResponsive(serial, adbRead);
            run('bun', ['run', 'build'], BUILD_TIMEOUT_MS);
            run(
                'bun',
                ['run', '--cwd', 'apps/mobile', 'prebuild:android', '--', '--clean'],
                BUILD_TIMEOUT_MS,
                acceptanceBuildEnvironment,
            );
            run(
                'bun',
                [
                    'run',
                    '--cwd',
                    'apps/mobile',
                    'android',
                    '--',
                    '--build-only',
                    '--variant',
                    'release',
                ],
                ANDROID_RELEASE_BUILD_TIMEOUT_MS,
                acceptanceBuildEnvironment,
            );
            adbRun(['install', '-r', releaseApk]);
            apkSha256 = createHash('sha256')
                .update(await readFile(releaseApk))
                .digest('hex');
            await desktopLease.claim();
            const deviceCommands = {
                readDevice: adbRead,
                runDevice: (arguments_: string[]) => adbRun(arguments_),
            };
            const cleanupIme = await prepareMobileFixtureIme(serial, {
                build: (directory) =>
                    run(
                        'bash',
                        [join(root, 'e2e/support/mobile-ime/build.sh'), directory],
                        BUILD_TIMEOUT_MS,
                    ),
                ...deviceCommands,
            });
            cleanupFixtureIme = await withMobileReducedMotion(serial, deviceCommands, cleanupIme);
        } catch (error) {
            setupFailure = error;
        }
        if (setupFailure) {
            await desktopLease.release();
            let receiptFailure: unknown;
            for (const caseId of caseIds) {
                try {
                    // Each frozen mobile check needs its own blocked lifecycle and device receipt for round finalization.
                    // eslint-disable-next-line no-await-in-loop
                    await recordAndroidSetupBlockedCase({
                        caseId,
                        desktopProfile: mobileAndroidAcceptanceCase(caseId).desktopProfile,
                        reportDirectory,
                        runDevice: (arguments_) => adbRead(arguments_, overallDeadlineMs),
                        serial,
                        sourceCommit,
                    });
                } catch (error) {
                    receiptFailure ??= error;
                }
            }
            const finalFailure = receiptFailure ?? setupFailure;
            throw finalFailure instanceof Error
                ? finalFailure
                : new Error('Android Acceptance setup failed');
        }
        if (!apkSha256) throw new Error('Android Acceptance build identity is unavailable');
        let caseFailure: unknown;
        const attemptedCaseIds: MobileAndroidAcceptanceCaseId[] = [];
        try {
            for (const caseId of caseIds) {
                // Each case owns an isolated app/profile lifecycle but reuses the exact same already-hashed release APK build.
                attemptedCaseIds.push(caseId);
                // eslint-disable-next-line no-await-in-loop -- each case owns its isolated device and profile lifecycle.
                await executeCase(caseId, sourceCommit, apkSha256);
            }
        } catch (error) {
            caseFailure = error;
        }
        try {
            await desktopLease.release();
        } catch (error) {
            // The fixture IME must still be restored on the device when the lease release fails.
            caseFailure ??= error;
        }
        let imeCleanupFailure: unknown;
        try {
            if (!cleanupFixtureIme) throw new Error('Fixture IME cleanup owner is unavailable');
            await cleanupFixtureImeWithRetry(cleanupFixtureIme);
            for (const caseId of attemptedCaseIds) {
                // eslint-disable-next-line no-await-in-loop -- the cleanup marker follows the same frozen case order.
                await markMobileFixtureImeRestored(
                    join(reportDirectory, 'assets', `${caseId}-mobile-device.json`),
                    { caseId, sourceCommit },
                );
            }
        } catch (error) {
            imeCleanupFailure = error;
        }
        if (caseFailure && imeCleanupFailure)
            throw new AggregateError(
                [caseFailure, imeCleanupFailure],
                'Android Acceptance case and fixture IME cleanup failed',
            );
        if (imeCleanupFailure)
            throw imeCleanupFailure instanceof Error
                ? imeCleanupFailure
                : new Error('Fixture IME cleanup failed');
        if (caseFailure)
            throw caseFailure instanceof Error
                ? caseFailure
                : new Error('Android Acceptance case failed');
    },
    { namespace: `android-${serial}` },
);

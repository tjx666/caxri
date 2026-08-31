#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    loadAcceptanceCasePlan,
    markCaseLifecycleReady,
} from '../.agents/skills/acceptance/scripts/report';
import type { MobileAcceptanceArtifact } from './mobile-acceptance-runtime';
import {
    assertMobileAcceptanceSourceIdentity,
    captureMobileAcceptanceCommand,
    collectMobileAcceptanceArtifacts,
    createMobileAcceptanceArtifact,
    runMobileAcceptanceCommand,
    startMobileAcceptanceRecording,
    writeMobileAcceptanceArtifact,
    writeMobileAcceptanceReceipt,
} from './mobile-acceptance-runtime';

const root = resolve(import.meta.dirname, '..');
const adb = join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
const releaseApk = join(root, 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk');
const serial = process.env.CAXRI_MOBILE_ACCEPTANCE_SERIAL;
if (!serial || !/^emulator-\d+$/u.test(serial))
    throw new Error('CAXRI_MOBILE_ACCEPTANCE_SERIAL must name one disposable Android emulator');
const requestedReportDirectory = process.env.CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR;
const requestedCaseId = process.env.CAXRI_MOBILE_ACCEPTANCE_CASE_ID;
if (Boolean(requestedReportDirectory) !== Boolean(requestedCaseId))
    throw new Error(
        'CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR and CAXRI_MOBILE_ACCEPTANCE_CASE_ID must be set together',
    );

const OVERALL_TIMEOUT_MS = 20 * 60_000;
const CLEANUP_RESERVE_MS = 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const E2E_TIMEOUT_MS = 5 * 60_000;
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
const read = (command: string, arguments_: string[], timeoutMs: number): string =>
    runMobileAcceptanceCommand({
        arguments: arguments_,
        captureOutput: true,
        command,
        cwd: root,
        deadlineMs: activeDeadlineMs,
        timeoutMs,
    });

let reportDirectory: string | undefined;
let caseId: string | undefined;
let launchId: string | undefined;
let sourceCommit: string | undefined;
let screenshotPath: string | undefined;
let videoPath: string | undefined;
let remoteVideoPath: string | undefined;
if (requestedReportDirectory && requestedCaseId) {
    const planned = await loadAcceptanceCasePlan(requestedReportDirectory, requestedCaseId);
    if (planned.item.surface !== 'mobile')
        throw new Error('The guarded Android acceptance case must use the mobile surface');
    if (
        planned.item.mobileDevice?.platform !== 'android' ||
        planned.item.mobileDevice.deviceId !== serial
    )
        throw new Error('The guarded Android acceptance target must match the frozen mobileDevice');
    if (planned.item.stateIsolation.mode !== 'isolated')
        throw new Error('The guarded Android acceptance case must use isolated state');
    const actualCommit = read('git', ['rev-parse', 'HEAD'], SOURCE_TIMEOUT_MS);
    assertMobileAcceptanceSourceIdentity({
        actualCommit,
        plannedCommit: planned.commit,
        status: read(
            'git',
            ['status', '--porcelain', '--untracked-files=normal'],
            SOURCE_TIMEOUT_MS,
        ),
    });
    sourceCommit = actualCommit.trim().toLowerCase();
    reportDirectory = planned.directory;
    caseId = requestedCaseId;
    screenshotPath = join(reportDirectory, 'assets', `${encodeURIComponent(caseId)}-android.png`);
    videoPath = join(reportDirectory, 'assets', `${encodeURIComponent(caseId)}-android.mp4`);
    remoteVideoPath = `/data/local/tmp/caxri-acceptance-${process.pid}.mp4`;
    launchId = await beginCaseLifecycle(reportDirectory, {
        caseId,
        profileIdentity: `android-emulator:${serial}:com.caxri.mobile:${randomUUID()}`,
        stateIsolation: planned.item.stateIsolation,
    });
}

let failure: unknown;
let isCleanupCompleted = false;
let isLifecycleReady = false;
let recording: Awaited<ReturnType<typeof startMobileAcceptanceRecording>> | undefined;
const artifacts: MobileAcceptanceArtifact[] = [];
try {
    run('bun', ['run', 'build'], BUILD_TIMEOUT_MS);
    run(
        'bun',
        ['run', '--cwd', 'apps/mobile', 'prebuild:android', '--', '--clean'],
        BUILD_TIMEOUT_MS,
    );
    run(
        'bun',
        ['run', '--cwd', 'apps/mobile', 'android', '--', '--build-only', '--variant', 'release'],
        BUILD_TIMEOUT_MS,
    );
    run(adb, ['-s', serial, 'install', '-r', releaseApk], DEVICE_TIMEOUT_MS);
    run(adb, ['-s', serial, 'shell', 'pm', 'clear', 'com.caxri.mobile'], DEVICE_TIMEOUT_MS);
    if (reportDirectory && caseId && launchId) {
        await markCaseLifecycleReady(reportDirectory, { caseId, launchId });
        isLifecycleReady = true;
        if (!remoteVideoPath) throw new Error('Android Acceptance recording path is missing');
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
        });
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (
            !/^\d+(?:\s+\d+)*$/u.test(
                read(adb, ['-s', serial, 'shell', 'pidof', 'screenrecord'], DEVICE_TIMEOUT_MS),
            )
        ) {
            throw new Error('Android Acceptance screen recording is not active');
        }
    }
    run(
        'bunx',
        ['--bun', 'playwright', 'test', 'e2e/mobile-short-reply.e2e.ts', '--reporter=line'],
        E2E_TIMEOUT_MS,
        {
            ...process.env,
            CAXRI_MOBILE_ACCEPTANCE_BUILD_MODE: 'release',
            ...(reportDirectory &&
                caseId && {
                    CAXRI_MOBILE_ACCEPTANCE_RESULT_RECEIPT: join(
                        reportDirectory,
                        'assets',
                        `${encodeURIComponent(caseId)}-result.json`,
                    ),
                    CAXRI_MOBILE_ACCEPTANCE_LAUNCH_ID: launchId,
                    CAXRI_MOBILE_ACCEPTANCE_SOURCE_COMMIT: sourceCommit,
                }),
        },
    );
} catch (error) {
    failure = error;
} finally {
    const activeRecording = recording;
    const collected = await collectMobileAcceptanceArtifacts({
        captureRecording:
            activeRecording && videoPath && remoteVideoPath
                ? async () => {
                      await activeRecording.stop();
                      run(
                          adb,
                          ['-s', serial, 'pull', remoteVideoPath, videoPath],
                          DEVICE_TIMEOUT_MS,
                          process.env,
                          overallDeadlineMs,
                      );
                      if (!caseId) throw new Error('Android Acceptance recording case is missing');
                      return createMobileAcceptanceArtifact(videoPath, {
                          path: `assets/${encodeURIComponent(caseId)}-android.mp4`,
                          source: 'android-framebuffer',
                          type: 'video',
                      });
                  }
                : undefined,
        captureScreenshot:
            screenshotPath && isLifecycleReady
                ? async () => {
                      if (!caseId) throw new Error('Android Acceptance screenshot case is missing');
                      const screenshot = captureMobileAcceptanceCommand({
                          arguments: ['-s', serial, 'exec-out', 'screencap', '-p'],
                          command: adb,
                          cwd: root,
                          deadlineMs: overallDeadlineMs,
                          timeoutMs: DEVICE_TIMEOUT_MS,
                      });
                      await writeMobileAcceptanceArtifact(screenshotPath, screenshot);
                      return createMobileAcceptanceArtifact(screenshotPath, {
                          path: `assets/${encodeURIComponent(caseId)}-android.png`,
                          source: 'android-framebuffer',
                          type: 'screenshot',
                      });
                  }
                : undefined,
        failure,
    });
    failure = collected.failure;
    artifacts.push(...collected.artifacts);
    if (recording && remoteVideoPath) {
        try {
            run(
                adb,
                ['-s', serial, 'shell', 'rm', '-f', remoteVideoPath],
                DEVICE_TIMEOUT_MS,
                process.env,
                overallDeadlineMs,
            );
        } catch (error) {
            failure ??= error;
        }
    }
    try {
        run(
            adb,
            ['-s', serial, 'shell', 'pm', 'clear', 'com.caxri.mobile'],
            DEVICE_TIMEOUT_MS,
            process.env,
            overallDeadlineMs,
        );
        isCleanupCompleted = true;
    } catch (error) {
        failure ??= error;
    }
    if (reportDirectory && caseId && launchId) {
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
}

if (reportDirectory && caseId && launchId && sourceCommit) {
    let apkSha256 = 'unavailable';
    try {
        apkSha256 = createHash('sha256')
            .update(await readFile(releaseApk))
            .digest('hex');
    } catch {
        // A blocked pre-build run still needs a device receipt that can finalize the round.
    }
    const status = failure ? (isLifecycleReady ? 'failed' : 'blocked') : 'passed';
    const receiptPath = join(
        reportDirectory,
        'assets',
        `${encodeURIComponent(caseId)}-mobile-device.json`,
    );
    await writeMobileAcceptanceReceipt(receiptPath, {
        appId: 'com.caxri.mobile',
        artifacts,
        build: { identity: apkSha256, mode: 'release' },
        caseId,
        cleanup: {
            appData: isCleanupCompleted ? 'cleared' : 'preserved',
            desktopProfile: 'managed-by-isolated-e2e',
        },
        device: { id: serial, kind: 'emulator', platform: 'android' },
        launchId,
        outcome:
            status === 'passed'
                ? 'one-bounded-reply-reached-the-waiting-agent'
                : status === 'failed'
                  ? 'acceptance-run-failed-after-device-ready'
                  : 'acceptance-run-blocked-before-device-ready',
        schemaVersion: 1,
        sourceCommit,
        status,
    });
    console.log(JSON.stringify({ acceptanceReceipt: receiptPath, status }));
}

if (failure)
    throw failure instanceof Error
        ? failure
        : new Error('Android acceptance failed with a non-Error value');

#!/usr/bin/env bun

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
    beginCaseLifecycle,
    completeCaseLifecycle,
} from '../.agents/skills/acceptance/scripts/case-lifecycle';
import { loadAcceptanceCasePlan } from '../.agents/skills/acceptance/scripts/report';
import {
    assertMobileAcceptanceSourceIdentity,
    clearMobileAcceptanceCaseArtifacts,
    runMobileAcceptanceCommand,
} from './mobile-acceptance-runtime';

const serial = process.env.CAXRI_MOBILE_ACCEPTANCE_SERIAL;
if (!serial || !/^emulator-\d+$/u.test(serial)) {
    throw new Error('CAXRI_MOBILE_ACCEPTANCE_SERIAL must name one disposable Android emulator');
}
const reportDirectory = process.env.CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR;
if (!reportDirectory) throw new Error('CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR is required');
const expectedApkSha256 = process.env.CAXRI_MOBILE_ACCEPTANCE_APK_SHA256;
if (!expectedApkSha256 || !/^[0-9a-f]{64}$/u.test(expectedApkSha256)) {
    throw new Error('CAXRI_MOBILE_ACCEPTANCE_APK_SHA256 must bind the exact release APK');
}

const CASE_ID = 'MOB-PAIR-01';
const planned = await loadAcceptanceCasePlan(reportDirectory, CASE_ID);
if (planned.item.surface !== 'desktop' || planned.item.stateIsolation.mode !== 'isolated') {
    throw new Error('Desktop pairing Acceptance requires an isolated desktop plan item');
}
const projectRoot = resolve(import.meta.dirname, '..');
const adb = join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
const releaseApk = join(
    projectRoot,
    'apps/mobile/android/app/build/outputs/apk/release/app-release.apk',
);
const SOURCE_TIMEOUT_MS = 10_000;
const BUILD_TIMEOUT_MS = 12 * 60_000;
const E2E_TIMEOUT_MS = 8 * 60_000;
const OVERALL_TIMEOUT_MS = 25 * 60_000;
const overallDeadlineMs = Date.now() + OVERALL_TIMEOUT_MS;

const run = (
    command: string,
    arguments_: string[],
    timeoutMs: number,
    environment = process.env,
    isCaptureOutput = false,
): string =>
    runMobileAcceptanceCommand({
        arguments: arguments_,
        captureOutput: isCaptureOutput,
        command,
        cwd: projectRoot,
        deadlineMs: overallDeadlineMs,
        environment,
        timeoutMs,
    });

const sourceCommit = run('git', ['rev-parse', 'HEAD'], SOURCE_TIMEOUT_MS, process.env, true)
    .trim()
    .toLowerCase();
const sourceStatus = run(
    'git',
    ['status', '--porcelain', '--untracked-files=normal'],
    SOURCE_TIMEOUT_MS,
    process.env,
    true,
);
assertMobileAcceptanceSourceIdentity({
    actualCommit: sourceCommit,
    plannedCommit: planned.commit,
    status: sourceStatus,
});
const actualApkSha256 = createHash('sha256')
    .update(await readFile(releaseApk))
    .digest('hex');
if (actualApkSha256 !== expectedApkSha256) {
    throw new Error('Desktop pairing Acceptance APK does not match the frozen mobile build');
}

const DEVICE_TIMEOUT_MS = 30_000;
await clearMobileAcceptanceCaseArtifacts(reportDirectory, CASE_ID);
const profileIdentity = `desktop-mobile-pairing:${serial}:${randomUUID()}`;
const launchId = await beginCaseLifecycle(reportDirectory, {
    caseId: CASE_ID,
    profileIdentity,
    stateIsolation: planned.item.stateIsolation,
});
const assetsDirectory = join(reportDirectory, 'assets');
const cleanupReceiptPath = join(assetsDirectory, `${CASE_ID}-cleanup.json`);
let failure: unknown;
let isDesktopCleanupCompleted = false;
let isMobileCleanupCompleted = false;
try {
    run(adb, ['-s', serial, 'install', '-r', releaseApk], DEVICE_TIMEOUT_MS);
    run(adb, ['-s', serial, 'shell', 'pm', 'clear', 'com.caxri.mobile'], DEVICE_TIMEOUT_MS);
    run('bun', ['run', 'build'], BUILD_TIMEOUT_MS);
    run(
        'bunx',
        [
            '--bun',
            'playwright',
            'test',
            'e2e/mobile-pairing-desktop-acceptance.e2e.ts',
            '--workers=1',
        ],
        E2E_TIMEOUT_MS,
        {
            ...process.env,
            CAXRI_MOBILE_ACCEPTANCE_ASSETS_DIR: assetsDirectory,
            CAXRI_MOBILE_ACCEPTANCE_CLEANUP_RECEIPT: cleanupReceiptPath,
            CAXRI_MOBILE_ACCEPTANCE_LAUNCH_ID: launchId,
            CAXRI_MOBILE_ACCEPTANCE_REPORT_DIR: reportDirectory,
            CAXRI_MOBILE_ACCEPTANCE_SCENARIO_RECEIPT: join(
                assetsDirectory,
                `${CASE_ID}-scenario.txt`,
            ),
            CAXRI_MOBILE_ACCEPTANCE_SERIAL: serial,
            CAXRI_MOBILE_ACCEPTANCE_SOURCE_COMMIT: sourceCommit,
        },
    );
    const cleanupReceipt = JSON.parse(await readFile(cleanupReceiptPath, 'utf8')) as {
        cleanupCompleted?: boolean;
    };
    isDesktopCleanupCompleted = cleanupReceipt.cleanupCompleted === true;
    if (!isDesktopCleanupCompleted)
        throw new Error('Desktop pairing fixture cleanup is incomplete');
} catch (error) {
    failure = error;
} finally {
    try {
        run(adb, ['-s', serial, 'shell', 'pm', 'clear', 'com.caxri.mobile'], DEVICE_TIMEOUT_MS);
        isMobileCleanupCompleted = true;
    } catch (error) {
        failure ??= error;
    }
    try {
        await completeCaseLifecycle(reportDirectory, {
            caseId: CASE_ID,
            cleanupCompleted: isDesktopCleanupCompleted && isMobileCleanupCompleted,
            cleanupRequested: true,
            launchId,
        });
    } catch (error) {
        failure ??= error;
    }
}

if (failure)
    throw failure instanceof Error ? failure : new Error('Desktop pairing Acceptance failed');

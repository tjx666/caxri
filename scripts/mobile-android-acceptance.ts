#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
    beginCaseLifecycle,
    completeCaseLifecycle,
    loadAcceptanceCasePlan,
    markCaseLifecycleReady,
} from '../.agents/skills/acceptance/scripts/report';

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

const run = (command: string, arguments_: string[], environment = process.env): void => {
    // oxlint-disable-next-line node/no-sync -- The guarded acceptance stages must finish in exact order before the next starts.
    const result = spawnSync(command, arguments_, {
        cwd: root,
        env: environment,
        shell: false,
        stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`${command} failed with status ${result.status ?? 'unknown'}`);
};

let reportDirectory: string | undefined;
let caseId: string | undefined;
let launchId: string | undefined;
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
    reportDirectory = planned.directory;
    caseId = requestedCaseId;
    launchId = await beginCaseLifecycle(reportDirectory, {
        caseId,
        profileIdentity: `android-emulator:${serial}:com.caxri.mobile:${randomUUID()}`,
        stateIsolation: planned.item.stateIsolation,
    });
}

let failure: unknown;
let isCleanupCompleted = false;
let isLifecycleReady = false;
try {
    run('bun', ['run', 'build']);
    run('bun', ['run', '--cwd', 'apps/mobile', 'prebuild:android', '--', '--clean']);
    run('bun', [
        'run',
        '--cwd',
        'apps/mobile',
        'android',
        '--',
        '--build-only',
        '--variant',
        'release',
    ]);
    run(adb, ['-s', serial, 'install', '-r', releaseApk]);
    run(adb, ['-s', serial, 'shell', 'pm', 'clear', 'com.caxri.mobile']);
    if (reportDirectory && caseId && launchId) {
        await markCaseLifecycleReady(reportDirectory, { caseId, launchId });
        isLifecycleReady = true;
    }
    run(
        'bunx',
        ['--bun', 'playwright', 'test', 'e2e/mobile-short-reply.e2e.ts', '--reporter=line'],
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
                }),
        },
    );
} catch (error) {
    failure = error;
} finally {
    try {
        run(adb, ['-s', serial, 'shell', 'pm', 'clear', 'com.caxri.mobile']);
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

if (reportDirectory && caseId) {
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
    await writeFile(
        receiptPath,
        `${JSON.stringify(
            {
                appId: 'com.caxri.mobile',
                build: { identity: apkSha256, mode: 'release' },
                caseId,
                cleanup: {
                    appData: isCleanupCompleted ? 'cleared' : 'preserved',
                    desktopProfile: 'managed-by-isolated-e2e',
                },
                device: { id: serial, kind: 'emulator', platform: 'android' },
                outcome:
                    status === 'passed'
                        ? 'one-bounded-reply-reached-the-waiting-agent'
                        : status === 'failed'
                          ? 'acceptance-run-failed-after-device-ready'
                          : 'acceptance-run-blocked-before-device-ready',
                schemaVersion: 1,
                status,
            },
            null,
            2,
        )}\n`,
        { encoding: 'utf8', flag: 'wx' },
    );
    console.log(JSON.stringify({ acceptanceReceipt: receiptPath, status }));
}

if (failure)
    throw failure instanceof Error
        ? failure
        : new Error('Android acceptance failed with a non-Error value');

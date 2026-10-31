import { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import {
    beginCaseLifecycle,
    completeCaseLifecycle,
} from '../.agents/skills/acceptance/scripts/case-lifecycle';
import { assertDecodablePng } from '../.agents/skills/acceptance/scripts/png-integrity';
import { loadAcceptanceCasePlan } from '../.agents/skills/acceptance/scripts/report-case-plan';
import { writeJsonAtomic, writeTextAtomic } from './atomic-json';
import type { mobileAndroidAcceptanceCase } from './mobile-android-cases';

const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/iu;
const RECORDING_START_TIMEOUT_MS = 5_000;
const RECORDING_STOP_TIMEOUT_MS = 10_000;

interface MobileAcceptanceCommand {
    arguments: string[];
    captureOutput?: boolean;
    command: string;
    cwd: string;
    deadlineMs: number;
    environment?: NodeJS.ProcessEnv;
    nowMs?: number;
    timeoutMs: number;
}

interface MobileAcceptanceRecording {
    arguments: string[];
    command: string;
    cwd: string;
    interrupt?: () => Promise<void> | void;
}

export interface MobileAcceptanceArtifact {
    path: string;
    sha256: string;
    source: 'android-framebuffer' | 'ios-simulator-framebuffer';
    type: 'screenshot' | 'video';
}

/**
 * Stops the one serialized Android framebuffer recording on the dedicated Acceptance device. Exit code 1 means the
 * bounded recording already ended, while any other failure prevents publishing a possibly incomplete MP4.
 */
export function interruptAndroidScreenrecord(
    input: { adb: string; cwd: string; serial: string; timeoutMs: number },
    spawnProcess: typeof spawnSync = spawnSync,
): void {
    const result = spawnProcess(
        input.adb,
        ['-s', input.serial, 'shell', 'pkill', '-INT', '-x', 'screenrecord'],
        {
            cwd: input.cwd,
            encoding: 'utf8',
            shell: false,
            stdio: 'pipe',
            timeout: input.timeoutMs,
        },
    );
    if (result.error) {
        if (errorCode(result.error) === 'ETIMEDOUT')
            throw new Error('Android Acceptance recording interrupt timed out');
        throw new Error('Android Acceptance recording interrupt failed to start');
    }
    if (result.status === 0) return;
    if (result.status === 1 && typeof result.stderr === 'string' && !result.stderr.trim()) return;
    throw new Error('Android Acceptance recording interrupt failed');
}

/**
 * Removes one case's replaceable evidence before a retry while preserving its append-only isolation history. Without
 * this boundary, a failed retry could leave a prior screenshot or success receipt available for the new launch.
 */
export async function clearMobileAcceptanceCaseArtifacts(
    reportDirectory: string,
    caseId: string,
): Promise<void> {
    const assetsDirectory = join(reportDirectory, 'assets');
    const prefix = `${encodeURIComponent(caseId)}-`;
    const lifecycleName = `${prefix}state-isolation.json`;
    const entries = await readdir(assetsDirectory, { withFileTypes: true });
    await Promise.all(
        entries
            .filter(({ name }) => name.startsWith(prefix) && name !== lifecycleName)
            .map((entry) => {
                if (entry.isDirectory()) {
                    throw new Error('Mobile Acceptance case artifacts must not be directories');
                }
                return rm(join(assetsDirectory, entry.name), { force: true });
            }),
    );
}

interface MobileAcceptanceArtifactCollection {
    artifacts: MobileAcceptanceArtifact[];
    failure: unknown;
}

type RecordingSpawn = typeof spawn;

function errorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
    return typeof error.code === 'string' ? error.code : undefined;
}

/**
 * Runs one Acceptance child with both a stage timeout and a shared overall deadline. The caller owns the deadline so
 * cleanup can reserve a final bounded window instead of inheriting an already exhausted build budget.
 */
export function runMobileAcceptanceCommand(
    input: MobileAcceptanceCommand,
    spawn: typeof spawnSync = spawnSync,
): string {
    const remainingMs = input.deadlineMs - (input.nowMs ?? Date.now());
    if (remainingMs <= 0) throw new Error('Mobile Acceptance exceeded its overall deadline');
    const timeout = Math.min(input.timeoutMs, remainingMs);
    const result = spawn(input.command, input.arguments, {
        cwd: input.cwd,
        encoding: input.captureOutput ? 'utf8' : undefined,
        env: input.environment ?? process.env,
        killSignal: 'SIGTERM',
        maxBuffer: input.captureOutput ? 4 * 1024 * 1024 : undefined,
        shell: false,
        stdio: input.captureOutput ? 'pipe' : 'inherit',
        timeout,
    });
    if (result.error) {
        if (errorCode(result.error) === 'ETIMEDOUT')
            throw new Error(`Mobile Acceptance command timed out after ${timeout}ms`);
        throw new Error('Mobile Acceptance command failed to start');
    }
    if (result.status !== 0)
        throw new Error(
            `Mobile Acceptance command failed with status ${result.status ?? 'unknown'}`,
        );
    return input.captureOutput && typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

/**
 * Captures device bytes without decoding stdout as text. Failures intentionally omit stdout and stderr because a
 * framebuffer can contain credentials or user-visible content.
 */
export function captureMobileAcceptanceCommand(
    input: MobileAcceptanceCommand,
    spawnProcess: typeof spawnSync = spawnSync,
): Buffer {
    const remainingMs = input.deadlineMs - (input.nowMs ?? Date.now());
    if (remainingMs <= 0) throw new Error('Mobile Acceptance exceeded its overall deadline');
    const timeout = Math.min(input.timeoutMs, remainingMs);
    const result = spawnProcess(input.command, input.arguments, {
        cwd: input.cwd,
        encoding: null,
        env: input.environment ?? process.env,
        killSignal: 'SIGTERM',
        maxBuffer: 32 * 1024 * 1024,
        shell: false,
        stdio: 'pipe',
        timeout,
    });
    if (result.error) {
        if (errorCode(result.error) === 'ETIMEDOUT')
            throw new Error(`Mobile Acceptance command timed out after ${timeout}ms`);
        throw new Error('Mobile Acceptance command failed to start');
    }
    if (result.status !== 0)
        throw new Error(
            `Mobile Acceptance command failed with status ${result.status ?? 'unknown'}`,
        );
    if (!Buffer.isBuffer(result.stdout) || result.stdout.length === 0)
        throw new Error('Mobile Acceptance command returned no binary evidence');
    return result.stdout;
}

async function waitForRecordingStart(child: ChildProcess): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(onTimeout, RECORDING_START_TIMEOUT_MS);
        function onTimeout() {
            child.off('error', onError);
            child.off('spawn', onSpawn);
            reject(new Error('Mobile Acceptance recording did not start'));
        }
        function onError() {
            clearTimeout(timer);
            child.off('spawn', onSpawn);
            reject(new Error('Mobile Acceptance recording failed to start'));
        }
        function onSpawn() {
            clearTimeout(timer);
            child.off('error', onError);
            resolve();
        }
        child.once('error', onError);
        child.once('spawn', onSpawn);
    });
}

async function waitForRecordingExit(
    child: ChildProcess,
    timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
    }
    return new Promise((resolve) => {
        const timer = setTimeout(onTimeout, timeoutMs);
        function onTimeout() {
            child.off('exit', onExit);
            resolve(undefined);
        }
        function onExit(code: number | null, signal: NodeJS.Signals | null) {
            clearTimeout(timer);
            resolve({ code, signal });
        }
        child.once('exit', onExit);
    });
}

/**
 * Owns the one persistent `adb screenrecord` child for a mobile case. Android callers provide a remote interrupt so
 * `screenrecord` flushes the MP4 index before the original adb child exits; signalling only the local adb process can
 * leave a non-empty but undecodable file. `stop()` is idempotent so normal completion and cleanup can safely converge.
 */
export async function startMobileAcceptanceRecording(
    input: MobileAcceptanceRecording,
    spawnProcess: RecordingSpawn = spawn,
): Promise<{ stop: () => Promise<void> }> {
    const child = spawnProcess(input.command, input.arguments, {
        cwd: input.cwd,
        shell: false,
        stdio: 'ignore',
    });
    await waitForRecordingStart(child);
    let processError: unknown;
    const recordError = (error: unknown) => {
        processError ??= error;
    };
    child.on('error', recordError);
    let stopPromise: Promise<void> | undefined;
    return {
        stop: () => {
            stopPromise ??= (async () => {
                const exit = waitForRecordingExit(child, RECORDING_STOP_TIMEOUT_MS);
                let interruptFailure: unknown;
                if (child.exitCode === null && child.signalCode === null) {
                    if (input.interrupt) {
                        try {
                            await input.interrupt();
                        } catch (error) {
                            interruptFailure = error;
                            child.kill('SIGINT');
                        }
                    } else {
                        child.kill('SIGINT');
                    }
                }
                let result = await exit;
                let isForced = false;
                if (!result) {
                    isForced = true;
                    const forcedExit = waitForRecordingExit(child, RECORDING_STOP_TIMEOUT_MS);
                    child.kill('SIGTERM');
                    result = await forcedExit;
                }
                child.off('error', recordError);
                if (processError) throw new Error('Mobile Acceptance recording failed');
                if (!result) throw new Error('Mobile Acceptance recording did not stop');
                if (interruptFailure)
                    throw new Error('Mobile Acceptance recording interrupt failed');
                if (isForced)
                    throw new Error('Mobile Acceptance recording required forced cleanup');
                if (result.code !== 0 && result.signal !== 'SIGINT') {
                    throw new Error('Mobile Acceptance recording exited unexpectedly');
                }
            })();
            return stopPromise;
        },
    };
}

export async function writeMobileAcceptanceArtifact(path: string, content: Buffer): Promise<void> {
    await writeTextAtomic(path, content);
}

async function sha256(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
    return hash.digest('hex');
}

/**
 * Produces the immutable artifact entry embedded in the device receipt. Screenshots must contain a decodable PNG
 * framebuffer; recordings remain subject to the report finalizer's ffprobe and sampled-frame checks.
 */
export async function createMobileAcceptanceArtifact(
    filePath: string,
    artifact: Omit<MobileAcceptanceArtifact, 'sha256'>,
): Promise<MobileAcceptanceArtifact> {
    const metadata = await stat(filePath);
    if (!metadata.isFile() || metadata.size === 0)
        throw new Error('Mobile Acceptance artifact must be a non-empty file');
    if (artifact.type === 'screenshot') {
        if (!artifact.path.endsWith('.png')) {
            throw new Error('Mobile Acceptance screenshot must be a valid PNG framebuffer capture');
        }
        await assertDecodablePng(await readFile(filePath));
    }
    return { ...artifact, sha256: await sha256(filePath) };
}

/**
 * Collects final screenshot and recording evidence even when the product check already failed. The original failure
 * remains authoritative while later capture failures are retained only when no earlier failure exists.
 */
export async function collectMobileAcceptanceArtifacts(input: {
    captureRecording?: () => Promise<MobileAcceptanceArtifact>;
    captureScreenshot?: () => Promise<MobileAcceptanceArtifact>;
    failure: unknown;
}): Promise<MobileAcceptanceArtifactCollection> {
    const artifacts: MobileAcceptanceArtifact[] = [];
    let failure = input.failure;
    for (const capture of [input.captureScreenshot, input.captureRecording]) {
        if (!capture) continue;
        try {
            // Sequential capture preserves the final screen before stopping the recording.
            // eslint-disable-next-line no-await-in-loop
            artifacts.push(await capture());
        } catch (error) {
            failure ??= error;
        }
    }
    return { artifacts, failure };
}

/**
 * Ensures evidence is built only from the clean source tree named by the frozen report.
 */
export function assertMobileAcceptanceSourceIdentity(input: {
    actualCommit: string;
    plannedCommit: string;
    status: string;
}): void {
    const actualCommit = input.actualCommit.trim().toLowerCase();
    const plannedCommit = input.plannedCommit.trim().toLowerCase();
    if (
        actualCommit !== plannedCommit ||
        !COMMIT_PATTERN.test(actualCommit) ||
        !COMMIT_PATTERN.test(plannedCommit)
    ) {
        throw new Error('Mobile Acceptance source does not match the frozen report commit');
    }
    if (input.status.trim().length > 0)
        throw new Error('Mobile Acceptance requires a clean source tree');
}

/**
 * Publishes the final receipt atomically so an authorized clean retry replaces only its predecessor.
 */
/**
 * Clears an Android app's data only when the app is installed. A run blocked before the release APK was ever installed
 * (a cold Gradle build killed by its budget) has nothing to clear, yet `pm clear` on the missing package failed, left
 * the isolated launch uncleaned, and refused every retry in that round. `pm list packages <id>` exits 0 and prints one
 * `package:<id>` line per substring match, so only an exact line counts as installed; a failed query still throws and
 * keeps the launch uncleaned.
 */
export function clearAndroidAppDataIfInstalled(
    appId: string,
    runDevice: (arguments_: string[]) => string,
): 'absent' | 'cleared' {
    const listed = runDevice(['shell', 'pm', 'list', 'packages', appId]);
    const isInstalled = listed.split(/\r?\n/u).some((line) => line.trim() === `package:${appId}`);
    if (!isInstalled) return 'absent';
    runDevice(['shell', 'pm', 'clear', appId]);
    return 'cleared';
}

export function writeMobileAcceptanceReceipt(path: string, receipt: unknown): Promise<void> {
    return writeJsonAtomic(path, receipt);
}

/**
 * Records a blocked lifecycle and device receipt for a frozen Android case whose run stopped before the device was
 * ready (a failed build, emulator, or Desktop setup), so the round can still be finalized. Cleanup clears app data only
 * when the app is installed; see {@link clearAndroidAppDataIfInstalled}.
 */
export async function recordAndroidSetupBlockedCase(input: {
    caseId: string;
    desktopProfile: ReturnType<typeof mobileAndroidAcceptanceCase>['desktopProfile'];
    reportDirectory: string;
    runDevice: (arguments_: string[]) => string;
    serial: string;
    sourceCommit: string;
}): Promise<void> {
    const { caseId, reportDirectory, serial } = input;
    const planned = await loadAcceptanceCasePlan(reportDirectory, caseId);
    await clearMobileAcceptanceCaseArtifacts(reportDirectory, caseId);
    const launchId = await beginCaseLifecycle(reportDirectory, {
        caseId,
        profileIdentity: `android-emulator:${serial}:setup-blocked:${randomUUID()}`,
        stateIsolation: planned.item.stateIsolation,
    });
    let isCleanupCompleted = false;
    let failure: unknown;
    try {
        clearAndroidAppDataIfInstalled('com.caxri.mobile', input.runDevice);
        isCleanupCompleted = true;
    } catch (error) {
        failure = error;
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
    await writeMobileAcceptanceReceipt(
        join(reportDirectory, 'assets', `${caseId}-mobile-device.json`),
        {
            appId: 'com.caxri.mobile',
            artifacts: [],
            build: { identity: 'unavailable', mode: 'release' },
            caseId,
            cleanup: {
                appData: isCleanupCompleted ? 'cleared' : 'preserved',
                desktopProfile: input.desktopProfile,
            },
            device: { id: serial, kind: 'emulator', platform: 'android' },
            launchId,
            outcome: 'acceptance-run-blocked-before-device-ready',
            schemaVersion: 1,
            sourceCommit: input.sourceCommit,
            status: 'blocked',
        },
    );
    if (failure)
        throw failure instanceof Error
            ? failure
            : new Error('Blocked Android Acceptance cleanup failed');
}

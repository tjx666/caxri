import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type {
    AndroidNodeObservation,
    AndroidNodeTextExpectation,
    AndroidSemanticNode,
} from './android-receipts';
import {
    observeAndroidNodeFromUiAutomator,
    resumedPackageFromWindowDump,
    semanticNodesFromUiAutomator,
} from './android-receipts';

export const CAXRI_ANDROID_PACKAGE = 'com.caxri.mobile';

const DEVICE_DUMP_PATH = '/data/local/tmp/caxri-ui.xml';

type AndroidAdbSpawn = (
    command: string,
    arguments_: string[],
    options: {
        encoding: 'utf8';
        killSignal: 'SIGTERM';
        maxBuffer: number;
        shell: false;
        timeout: number;
    },
) => { error?: unknown; status: number | null; stdout?: string };

const androidAdbPath = (): string => {
    const androidSdkRoot: unknown = Reflect.get(process.env, 'ANDROID_SDK_ROOT');
    const androidHome: unknown = Reflect.get(process.env, 'ANDROID_HOME');
    const sdkRoot =
        typeof androidSdkRoot === 'string'
            ? androidSdkRoot
            : typeof androidHome === 'string'
              ? androidHome
              : undefined;
    return sdkRoot
        ? join(sdkRoot, 'platform-tools', 'adb')
        : join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb');
};

/**
 * Runs ADB with an argv array and deliberately excludes stdout/stderr from failures. Device output can contain
 * credentials, visible source, or Terminal content even when the requested command normally returns metadata.
 */
export const runAndroidAdb = (
    serial: string,
    arguments_: string[],
    options: { spawn?: AndroidAdbSpawn; timeoutMs?: number } = {},
): string => {
    const spawn: AndroidAdbSpawn = options.spawn ?? spawnSync;
    const result = spawn(androidAdbPath(), ['-s', serial, ...arguments_], {
        encoding: 'utf8',
        killSignal: 'SIGTERM',
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
        timeout: options.timeoutMs ?? 15_000,
    });
    if (result.error) {
        const code = (result.error as { code?: unknown }).code;
        if (code === 'ETIMEDOUT') throw new Error('adb timed out');
        throw new Error('adb failed to start');
    }
    if (result.status !== 0)
        throw new Error(`adb failed with status ${result.status ?? 'unknown'}`);
    return typeof result.stdout === 'string' ? result.stdout.trim() : '';
};

/**
 * Reads the foreground Caxri accessibility tree only inside this callback boundary and removes both dump copies.
 * Consumers must project the XML to content-free values before returning.
 */
const withAndroidUiAutomatorDump = async <T>(
    serial: string,
    project: (source: string) => T,
): Promise<T> => {
    const windowDump = runAndroidAdb(serial, ['shell', 'dumpsys', 'window']);
    if (resumedPackageFromWindowDump(windowDump) !== CAXRI_ANDROID_PACKAGE)
        throw new Error('Caxri must own the foreground Activity before semantic capture');

    const directory = await mkdtemp(join(tmpdir(), 'caxri-android-'));
    const localDumpPath = join(directory, 'window.xml');
    try {
        runAndroidAdb(serial, ['shell', 'uiautomator', 'dump', DEVICE_DUMP_PATH]);
        runAndroidAdb(serial, ['pull', DEVICE_DUMP_PATH, localDumpPath]);
        return project(await readFile(localDumpPath, 'utf8'));
    } finally {
        try {
            runAndroidAdb(serial, ['shell', 'rm', '-f', DEVICE_DUMP_PATH]);
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    }
};

/**
 * Captures only stable resource identifiers and structural flags.
 */
export const captureAndroidSemanticNodes = (serial: string): Promise<AndroidSemanticNode[]> =>
    withAndroidUiAutomatorDump(serial, semanticNodesFromUiAutomator);

/**
 * Observes one Caxri control without returning its text or accessibility description.
 */
export const observeAndroidNode = (
    serial: string,
    checkId: string,
    expectedText?: AndroidNodeTextExpectation,
): Promise<AndroidNodeObservation> =>
    withAndroidUiAutomatorDump(serial, (source) =>
        observeAndroidNodeFromUiAutomator(source, checkId, expectedText),
    );

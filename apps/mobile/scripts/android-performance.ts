#!/usr/bin/env bun

import process from 'node:process';

import {
    captureAndroidSemanticNodes,
    CAXRI_ANDROID_PACKAGE,
    runAndroidAdb,
} from './android-device-bridge';
import { parseAndroidActivityStart, parseAndroidFrameStats } from './android-performance-receipts';

const DEFAULT_METRO_URL = 'http://127.0.0.1:8081';
const READY_TIMEOUT_MS = 15_000;

interface Arguments {
    metroUrl: string;
    readyCheckId: string;
    serial: string;
}

const argumentAfter = (values: string[], name: string): string | undefined => {
    const index = values.indexOf(name);
    return index === -1 ? undefined : values[index + 1];
};

const parseArguments = (values: string[]): Arguments => {
    const serial = argumentAfter(values, '--serial');
    if (!serial || !/^[\w.:-]{1,200}$/u.test(serial))
        throw new Error('A valid explicit --serial is required');
    const readyCheckId = argumentAfter(values, '--ready-check-id');
    if (!readyCheckId || !/^[a-z][a-z0-9_-]{2,100}$/u.test(readyCheckId))
        throw new Error('A stable explicit --ready-check-id is required');
    const metroUrl = argumentAfter(values, '--metro-url') ?? DEFAULT_METRO_URL;
    const parsedUrl = new URL(metroUrl);
    if (
        !['http:', 'https:'].includes(parsedUrl.protocol) ||
        parsedUrl.username ||
        parsedUrl.password
    )
        throw new Error('--metro-url must be an HTTP(S) URL without credentials');
    return { metroUrl: parsedUrl.href, readyCheckId, serial };
};

const developmentClientUrl = (metroUrl: string): string =>
    `exp+caxri-mobile://expo-development-client/?url=${encodeURIComponent(metroUrl)}`;

const delay = async (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });

const waitForReadyCheck = async (serial: string, checkId: string): Promise<number> => {
    const startedAt = performance.now();
    let lastFailure: unknown;
    while (performance.now() - startedAt < READY_TIMEOUT_MS) {
        try {
            // eslint-disable-next-line no-await-in-loop -- every semantic capture observes the next readiness state.
            const nodes = await captureAndroidSemanticNodes(serial);
            if (nodes.some((node) => node.checkId === checkId))
                return Math.round(performance.now() - startedAt);
        } catch (error) {
            lastFailure = error;
        }
        // eslint-disable-next-line no-await-in-loop -- bounded polling must not issue concurrent device captures.
        await delay(100);
    }
    if (lastFailure instanceof Error && lastFailure.message.includes('foreground Activity'))
        throw new Error('Caxri did not reach the foreground before the performance timeout');
    throw new Error('The requested ready check did not appear before the performance timeout');
};

const launch = (serial: string, url: string, shouldStopFirst: boolean): string =>
    runAndroidAdb(serial, [
        'shell',
        'am',
        'start',
        ...(shouldStopFirst ? ['-S'] : []),
        '-W',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        url,
        CAXRI_ANDROID_PACKAGE,
    ]);

const measureLaunch = async (
    serial: string,
    url: string,
    readyCheckId: string,
    shouldStopFirst: boolean,
): Promise<object> => {
    runAndroidAdb(serial, ['shell', 'dumpsys', 'gfxinfo', CAXRI_ANDROID_PACKAGE, 'reset']);
    const activity = parseAndroidActivityStart(launch(serial, url, shouldStopFirst));
    const readyCheckUpperBoundMs = await waitForReadyCheck(serial, readyCheckId);
    const frames = parseAndroidFrameStats(
        runAndroidAdb(serial, ['shell', 'dumpsys', 'gfxinfo', CAXRI_ANDROID_PACKAGE]),
    );
    return { activity, frames, readyCheckUpperBoundMs };
};

const main = async (): Promise<void> => {
    const input = parseArguments(process.argv.slice(2));
    if (!runAndroidAdb(input.serial, ['shell', 'pm', 'path', CAXRI_ANDROID_PACKAGE]))
        throw new Error('The Caxri Android development build is not installed');

    const url = developmentClientUrl(input.metroUrl);
    const cold = await measureLaunch(input.serial, url, input.readyCheckId, true);
    runAndroidAdb(input.serial, ['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
    await delay(250);
    const warm = await measureLaunch(input.serial, url, input.readyCheckId, false);

    console.log(
        JSON.stringify(
            {
                advisory:
                    'Development-client timings are diagnostic only; enforce budgets against a release build.',
                buildProfile: 'development-client',
                cold,
                package: CAXRI_ANDROID_PACKAGE,
                readyCheckId: input.readyCheckId,
                schemaVersion: 1,
                serial: input.serial,
                warm,
            },
            null,
            2,
        ),
    );
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

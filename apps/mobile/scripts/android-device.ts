#!/usr/bin/env bun

import process from 'node:process';

import {
    captureAndroidSemanticNodes,
    CAXRI_ANDROID_PACKAGE,
    runAndroidAdb,
} from './android-device-bridge';
import { centerOfAndroidBounds, isAndroidCheckId } from './android-receipts';

interface Arguments {
    checkId?: string;
    command: 'inspect' | 'semantics' | 'tap' | 'wake';
    serial: string;
}

const parseArguments = (values: string[]): Arguments => {
    const command = values[0];
    if (!['inspect', 'semantics', 'tap', 'wake'].includes(command))
        throw new Error('Expected inspect, semantics, tap, or wake');
    const serialIndex = values.indexOf('--serial');
    const serial = values[serialIndex + 1];
    if (serialIndex === -1 || !serial || !/^[\w.:-]{1,200}$/u.test(serial))
        throw new Error('A valid explicit --serial is required');
    const checkIdIndex = values.indexOf('--check-id');
    const checkId = values[checkIdIndex + 1];
    if (command === 'tap' && (!checkId || !isAndroidCheckId(checkId)))
        throw new Error('tap requires a valid --check-id');
    return { command: command as Arguments['command'], serial, ...(checkId && { checkId }) };
};

const deviceProperty = (serial: string, property: string): string =>
    runAndroidAdb(serial, ['shell', 'getprop', property]);

const inspect = (serial: string): object => ({
    apiLevel: Number(deviceProperty(serial, 'ro.build.version.sdk')),
    manufacturer: deviceProperty(serial, 'ro.product.manufacturer'),
    model: deviceProperty(serial, 'ro.product.model'),
    release: deviceProperty(serial, 'ro.build.version.release'),
    serial,
});

const semantics = async (serial: string): Promise<object> => ({
    package: CAXRI_ANDROID_PACKAGE,
    serial,
    checks: await captureAndroidSemanticNodes(serial),
});

const tap = async (serial: string, checkId: string): Promise<object> => {
    const node = (await captureAndroidSemanticNodes(serial)).find(
        (candidate) => candidate.checkId === checkId,
    );
    if (!node || !node.clickable || !node.enabled)
        throw new Error('The requested Caxri control is unavailable');
    const point = centerOfAndroidBounds(node.bounds);
    runAndroidAdb(serial, ['shell', 'input', 'tap', String(point.x), String(point.y)]);
    return { checkId, serial, status: 'tap-requested' };
};

const main = async (): Promise<void> => {
    const input = parseArguments(process.argv.slice(2));
    if (input.command === 'wake') {
        runAndroidAdb(input.serial, ['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
        console.log(JSON.stringify({ serial: input.serial, status: 'wake-requested' }));
        return;
    }
    if (input.command === 'tap') {
        if (!input.checkId) throw new Error('tap requires a valid --check-id');
        console.log(JSON.stringify(await tap(input.serial, input.checkId)));
        return;
    }
    const receipt =
        input.command === 'inspect' ? inspect(input.serial) : await semantics(input.serial);
    console.log(JSON.stringify(receipt, null, 2));
};

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

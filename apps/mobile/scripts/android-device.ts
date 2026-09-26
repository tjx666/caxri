#!/usr/bin/env bun

import { Buffer } from 'node:buffer';
import process from 'node:process';

import {
    captureAndroidSemanticNodes,
    CAXRI_ANDROID_PACKAGE,
    observeAndroidNode,
    runAndroidAdb,
} from './android-device-bridge';
import type { AndroidNodeTextExpectation } from './android-receipts';
import { centerOfAndroidBounds, isAndroidCheckId } from './android-receipts';

interface Arguments {
    checkId?: string;
    command: 'inspect' | 'observe' | 'semantics' | 'tap' | 'wake';
    expectedText?: AndroidNodeTextExpectation;
    /**
     * Holds the touch long enough to fire a React Native long press instead of a tap.
     */
    isLongPress: boolean;
    serial: string;
}

const parseExpectedText = (values: string[]): AndroidNodeTextExpectation | undefined => {
    const matchIndex = values.indexOf('--match');
    const textIndex = values.indexOf('--expected-text-base64');
    if (matchIndex === -1 && textIndex === -1) return;
    if (matchIndex === -1 || textIndex === -1)
        throw new Error('observe text matching requires both matching arguments');

    const kind = values.at(matchIndex + 1);
    const encoded = values.at(textIndex + 1);
    if (encoded === undefined || (kind !== 'equals' && kind !== 'includes'))
        throw new Error('Invalid observe text matching arguments');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded))
        throw new Error('Invalid observe text encoding');

    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) throw new Error('Invalid observe text encoding');
    let value: string;
    try {
        value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        throw new Error('Invalid observe text encoding');
    }
    if (kind === 'includes' && value.length === 0)
        throw new Error('Android includes text must not be empty');
    return { kind, value };
};

const parseArguments = (values: string[]): Arguments => {
    const command = values[0];
    if (!['inspect', 'observe', 'semantics', 'tap', 'wake'].includes(command))
        throw new Error('Expected inspect, observe, semantics, tap, or wake');
    const serialIndex = values.indexOf('--serial');
    const serial = values[serialIndex + 1];
    if (serialIndex === -1 || !serial || !/^[\w.:-]{1,200}$/u.test(serial))
        throw new Error('A valid explicit --serial is required');
    const checkIdIndex = values.indexOf('--check-id');
    const checkId = values[checkIdIndex + 1];
    if ((command === 'tap' || command === 'observe') && (!checkId || !isAndroidCheckId(checkId)))
        throw new Error('tap and observe require a valid --check-id');
    const expectedText = command === 'observe' ? parseExpectedText(values) : undefined;
    if (
        command !== 'observe' &&
        values.some((value) => value === '--match' || value === '--expected-text-base64')
    )
        throw new Error('Text matching requires observe');
    const isLongPress = values.includes('--long-press');
    if (isLongPress && command !== 'tap') throw new Error('--long-press requires tap');
    return {
        command: command as Arguments['command'],
        isLongPress,
        serial,
        ...(checkId && { checkId }),
        ...(expectedText && { expectedText }),
    };
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

/**
 * A zero-distance swipe is ADB's way to hold one point; 800 ms clears React Native's 500 ms default long-press delay.
 */
const LONG_PRESS_MS = 800;

const tap = async (serial: string, checkId: string, isLongPress: boolean): Promise<object> => {
    const node = (await captureAndroidSemanticNodes(serial)).find(
        (candidate) => candidate.checkId === checkId,
    );
    if (!node || !node.clickable || !node.enabled)
        throw new Error('The requested Caxri control is unavailable');
    const point = centerOfAndroidBounds(node.bounds);
    const x = String(point.x);
    const y = String(point.y);
    if (isLongPress)
        runAndroidAdb(serial, ['shell', 'input', 'swipe', x, y, x, y, String(LONG_PRESS_MS)]);
    else runAndroidAdb(serial, ['shell', 'input', 'tap', x, y]);
    return {
        checkId,
        serial,
        status: isLongPress ? 'long-press-requested' : 'tap-requested',
    };
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
        console.log(JSON.stringify(await tap(input.serial, input.checkId, input.isLongPress)));
        return;
    }
    if (input.command === 'observe') {
        if (!input.checkId) throw new Error('observe requires a valid --check-id');
        console.log(
            JSON.stringify(
                await observeAndroidNode(input.serial, input.checkId, input.expectedText),
            ),
        );
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

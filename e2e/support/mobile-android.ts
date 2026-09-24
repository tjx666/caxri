import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
    interruptAndroidScreenrecord,
    startMobileAcceptanceRecording,
} from '../../scripts/mobile-acceptance-runtime.ts';
import type { AndroidDisplayState } from '../../scripts/mobile-android-cases.ts';
import { parseAndroidDisplayState } from '../../scripts/mobile-android-cases.ts';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '../..');
const androidDeviceScript = join(projectRoot, 'apps/mobile/scripts/android-device.ts');
const adb = join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb');

export interface MobileSemanticNode {
    bounds: string;
    checkId: string;
    clickable: boolean;
    enabled: boolean;
}

/**
 * `adb shell` parses its command a second time. Quoting keeps pairing-link query separators inside the single deep-link
 * argument instead of letting the device shell treat them as command operators.
 */
const deviceShellQuote = (value: string): string => `'${value.replaceAll("'", String.raw`'\''`)}'`;

export async function runMobileDeviceCommand(
    executable: string,
    arguments_: string[],
    output: 'capture' | 'ignore' = 'ignore',
): Promise<string> {
    try {
        const result = await execFileAsync(executable, arguments_, {
            cwd: projectRoot,
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
        });
        return output === 'capture' ? result.stdout.trim() : '';
    } catch {
        throw new Error('A mobile Acceptance device command failed');
    }
}

export const adbShell = (serial: string, arguments_: string[]): Promise<string> =>
    runMobileDeviceCommand(adb, ['-s', serial, 'shell', ...arguments_], 'capture');

export async function mobileDisplayState(serial: string): Promise<AndroidDisplayState> {
    const [density, fontScale, rotation, size] = await Promise.all([
        adbShell(serial, ['wm', 'density']),
        adbShell(serial, ['settings', 'get', 'system', 'font_scale']),
        adbShell(serial, ['dumpsys', 'input']),
        adbShell(serial, ['wm', 'size']),
    ]);
    return parseAndroidDisplayState({ density, fontScale, rotation, size });
}

export async function restoreMobileDisplayState(
    serial: string,
    original: AndroidDisplayState,
): Promise<void> {
    await adbShell(serial, [
        'wm',
        'size',
        original.size.override
            ? `${original.size.override.width}x${original.size.override.height}`
            : 'reset',
    ]);
    await adbShell(serial, [
        'wm',
        'density',
        original.density.override ? String(original.density.override) : 'reset',
    ]);
    if (JSON.stringify(await mobileDisplayState(serial)) !== JSON.stringify(original))
        throw new Error('Android display state was not restored exactly');
}

/**
 * Toggles every emulator network transport used by the Android Acceptance fixture. Disabling Wi-Fi alone leaves the
 * emulator's cellular route to 10.0.2.2 active, so the stale-session scenario would never actually disconnect.
 */
export async function setMobileNetworkAvailable(
    serial: string,
    isAvailable: boolean,
    shell: typeof adbShell = adbShell,
): Promise<void> {
    const action = isAvailable ? 'enable' : 'disable';
    let failure: unknown;
    for (const service of ['wifi', 'data']) {
        try {
            // eslint-disable-next-line no-await-in-loop -- both transports must be attempted even if the first fails.
            await shell(serial, ['svc', service, action]);
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure) throw new Error(`Mobile Acceptance could not ${action} every network transport`);
}

/**
 * Starts one device-framebuffer recording through the shared Acceptance process owner. The caller chooses the exact
 * stop boundary so private reply text never has to enter a report-bound recording.
 */
export const startMobileFramebufferRecording = (serial: string, remotePath: string) =>
    startMobileAcceptanceRecording({
        arguments: [
            '-s',
            serial,
            'shell',
            'screenrecord',
            '--bit-rate',
            '8000000',
            '--time-limit',
            '180',
            remotePath,
        ],
        command: adb,
        cwd: projectRoot,
        interrupt: () => {
            interruptAndroidScreenrecord({
                adb,
                cwd: projectRoot,
                serial,
                timeoutMs: 30_000,
            });
        },
    });

export async function pullMobileFramebufferRecording(
    serial: string,
    remotePath: string,
    localPath: string,
): Promise<void> {
    await mkdir(dirname(localPath), { recursive: true });
    try {
        await runMobileDeviceCommand(adb, ['-s', serial, 'pull', remotePath, localPath]);
    } finally {
        await adbShell(serial, ['rm', '-f', remotePath]);
    }
}

export async function mobileSemantics(serial: string): Promise<MobileSemanticNode[]> {
    const source = await runMobileDeviceCommand(
        'bun',
        ['run', androidDeviceScript, 'semantics', '--serial', serial],
        'capture',
    );
    return (JSON.parse(source) as { checks: MobileSemanticNode[] }).checks;
}

export const tapMobileCheck = (serial: string, checkId: string): Promise<string> =>
    runMobileDeviceCommand('bun', [
        'run',
        androidDeviceScript,
        'tap',
        '--serial',
        serial,
        '--check-id',
        checkId,
    ]);

export async function waitForMobile<T>(
    read: () => T | Promise<T>,
    isAccepted: (value: T) => boolean,
    timeoutMs = 30_000,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    do {
        // eslint-disable-next-line no-await-in-loop -- each observation depends on the previous state transition.
        const value = await read();
        if (isAccepted(value)) return value;
        // eslint-disable-next-line no-await-in-loop -- bounded device polling avoids duplicate automation actions.
        await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new Error('Mobile Acceptance timed out');
}

export async function openMobilePairingLink(serial: string, pairingLink: string): Promise<void> {
    try {
        await execFileAsync(
            adb,
            [
                '-s',
                serial,
                'shell',
                `am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d ${deviceShellQuote(pairingLink)} com.caxri.mobile`,
            ],
            { cwd: projectRoot, encoding: 'utf8' },
        );
    } catch {
        throw new Error('The pairing link could not be delivered');
    }
}

export async function captureMobileFramebuffer(serial: string, path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    try {
        const result = await execFileAsync(adb, ['-s', serial, 'exec-out', 'screencap', '-p'], {
            cwd: projectRoot,
            encoding: 'buffer',
            maxBuffer: 32 * 1024 * 1024,
        });
        if (!Buffer.isBuffer(result.stdout) || result.stdout.length === 0) {
            throw new Error('Android framebuffer capture was empty');
        }
        await writeFile(path, result.stdout);
    } catch {
        throw new Error('Android framebuffer capture failed');
    }
}

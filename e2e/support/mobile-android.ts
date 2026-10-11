import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    checked: boolean;
    checkId: string;
    clickable: boolean;
    enabled: boolean;
    selected: boolean;
}

export interface MobileNodeObservation {
    exists: boolean;
    focused: boolean;
    textMatches?: boolean;
}

export function androidBounds(source: string): {
    bottom: number;
    left: number;
    right: number;
    top: number;
} | null {
    const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(source);
    if (!match) return null;
    const [, left, top, right, bottom] = match.map(Number);
    if (right <= left || bottom <= top) return null;
    return { bottom, left, right, top };
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
    timeoutMs?: number,
): Promise<string> {
    try {
        const result = await execFileAsync(executable, arguments_, {
            cwd: projectRoot,
            encoding: 'utf8',
            maxBuffer: 4 * 1024 * 1024,
            timeout: timeoutMs,
        });
        return output === 'capture' ? result.stdout.trim() : '';
    } catch (error) {
        /**
         * Preserve only closed driver reasons; arbitrary stderr can contain device or credential data.
         */
        const stderr =
            error !== null && typeof error === 'object' && 'stderr' in error
                ? error.stderr
                : undefined;
        const reasons = new Map([
            ['The requested Caxri control is unavailable', 'control-unavailable'],
            ['Caxri must own the foreground Activity before semantic capture', 'foreground-lost'],
            ['adb timed out', 'adb-timeout'],
            ['adb failed to start', 'adb-start-failed'],
        ]);
        const reason = typeof stderr === 'string' ? reasons.get(stderr.trim()) : undefined;
        // eslint-disable-next-line preserve-caught-error -- Raw subprocess causes can expose device output and credentials.
        throw new Error(`A mobile Acceptance device command failed (${reason ?? 'driver-failed'})`);
    }
}

export const adbShell = (serial: string, arguments_: string[]): Promise<string> =>
    runMobileDeviceCommand(adb, ['-s', serial, 'shell', ...arguments_], 'capture');

export const pushMobileFixture = (
    serial: string,
    localPath: string,
    remotePath: string,
): Promise<string> =>
    runMobileDeviceCommand(adb, ['-s', serial, 'push', localPath, remotePath], 'capture');

/**
 * Reads only a fixed native control's bounds; the raw accessibility tree never leaves the device probe.
 */
async function mobileNativeControlBounds(
    serial: string,
    query: { text?: string; resourceId?: string; singleImageTile?: boolean },
): Promise<ReturnType<typeof androidBounds>> {
    const dumpPath = '/data/local/tmp/caxri-acceptance-native.xml';
    let source: string;
    try {
        await adbShell(serial, ['uiautomator', 'dump', dumpPath]);
        source = await adbShell(serial, ['cat', dumpPath]);
    } finally {
        await adbShell(serial, ['rm', '-f', dumpPath]);
    }
    const candidates = source
        .matchAll(/<node\b[^>]*>/gu)
        .map(([node]) => node)
        .filter((node) => {
            if (query.singleImageTile) {
                const tile = androidBounds(/\bbounds="([^"]+)"/u.exec(node)?.[1] ?? '');
                if (!tile || !node.includes('clickable="true"')) return false;
                const width = tile.right - tile.left;
                const height = tile.bottom - tile.top;
                return width >= 200 && height >= 200 && Math.abs(width - height) <= 2;
            }
            const attribute = query.text ? 'text' : 'resource-id';
            const value = query.text ?? query.resourceId;
            return new RegExp(String.raw`\b${attribute}="([^"]*)"`, 'u').exec(node)?.[1] === value;
        })
        .toArray();
    if (candidates.length !== 1) return null;
    const node = candidates[0];
    if (!node.includes('enabled="true"')) return null;
    return androidBounds(/\bbounds="([^"]+)"/u.exec(node)?.[1] ?? '');
}

export async function tapMobileNativeControl(
    serial: string,
    query: { text?: string; resourceId?: string; singleImageTile?: boolean },
): Promise<void> {
    const bounds = await waitForMobile(
        () => mobileNativeControlBounds(serial, query),
        (candidate) => candidate !== null,
        15_000,
    );
    if (!bounds) throw new Error('Native mobile control is unavailable');
    await adbShell(serial, [
        'input',
        'tap',
        String(Math.floor((bounds.left + bounds.right) / 2)),
        String(Math.floor((bounds.top + bounds.bottom) / 2)),
    ]);
}

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
    await adbShell(serial, ['settings', 'put', 'system', 'font_scale', String(original.fontScale)]);
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

/**
 * Copies a finished recording for a scenario's own analysis and leaves the device file in place, because the Android
 * Acceptance runner still collects it as the case's video after the scenario returns.
 */
export async function copyMobileFramebufferRecording(
    serial: string,
    remotePath: string,
    localPath: string,
): Promise<void> {
    await mkdir(dirname(localPath), { recursive: true });
    await runMobileDeviceCommand(adb, ['-s', serial, 'pull', remotePath, localPath]);
}

export async function mobileSemantics(serial: string): Promise<MobileSemanticNode[]> {
    const source = await runMobileDeviceCommand(
        'bun',
        ['run', androidDeviceScript, 'semantics', '--serial', serial],
        'capture',
    );
    return (JSON.parse(source) as { checks: MobileSemanticNode[] }).checks;
}

/**
 * Compares native text inside the device helper and returns no text or raw accessibility XML.
 */
export async function observeMobileNode(
    serial: string,
    checkId: string,
    expectedText?: { kind: 'equals' | 'includes'; value: string },
): Promise<MobileNodeObservation> {
    const arguments_ = [
        'run',
        androidDeviceScript,
        'observe',
        '--serial',
        serial,
        '--check-id',
        checkId,
    ];
    if (expectedText)
        arguments_.push(
            '--match',
            expectedText.kind,
            '--expected-text-base64',
            Buffer.from(expectedText.value, 'utf8').toString('base64'),
        );
    const source = await runMobileDeviceCommand('bun', arguments_, 'capture');
    return JSON.parse(source) as MobileNodeObservation;
}

export const tapMobileCheck = (
    serial: string,
    checkId: string,
    options: { isLongPress?: boolean } = {},
): Promise<string> =>
    runMobileDeviceCommand('bun', [
        'run',
        androidDeviceScript,
        'tap',
        '--serial',
        serial,
        '--check-id',
        checkId,
        ...(options.isLongPress ? ['--long-press'] : []),
    ]);

/**
 * React Native can expose a visible Pressable with `clickable=false` in Android's accessibility dump. Tap its verified
 * device bounds and prove the resulting product state separately.
 */
export async function tapMobileCheckByBounds(serial: string, checkId: string): Promise<void> {
    const nodes = await mobileSemantics(serial);
    const target = nodes.find((node) => node.checkId === checkId);
    const bounds = target && androidBounds(target.bounds);
    if (!bounds || !target.enabled) {
        const visible = nodes
            .filter((node) => node.checkId.startsWith(checkId.split('-', 1)[0]))
            .map((node) => node.checkId);
        throw new Error(`Mobile control ${checkId} is unavailable; visible: ${visible.join(',')}`);
    }
    await adbShell(serial, [
        'input',
        'tap',
        String(Math.floor((bounds.left + bounds.right) / 2)),
        String(Math.floor((bounds.top + bounds.bottom) / 2)),
    ]);
}

/**
 * Control devices take the Terminal lease automatically, so watch-only assertions first release it. Release stays in
 * force until the reader leaves the Terminal, so the take-over control returns and nothing re-acquires the lease.
 */
export async function releaseMobileTerminalLease(serial: string): Promise<void> {
    await tapMobileCheck(serial, 'terminal-release');
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            nodes.some(({ checkId, enabled }) => checkId === 'terminal-take-over' && enabled),
    );
}

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

/**
 * Hashes only the framebuffer rows and columns inside `bounds`, so a status-bar clock or an unrelated animation
 * elsewhere on screen cannot make two frames of an unchanged region look different. Raw `screencap` output is a small
 * header followed by RGBA pixels; the header length differs across Android releases, so it is derived from the size.
 */
export async function mobileRegionFingerprint(
    serial: string,
    bounds: { bottom: number; left: number; right: number; top: number },
): Promise<string> {
    const result = await execFileAsync(adb, ['-s', serial, 'exec-out', 'screencap'], {
        cwd: projectRoot,
        encoding: 'buffer',
        maxBuffer: 32 * 1024 * 1024,
    });
    const frame = result.stdout;
    const width = frame.readUInt32LE(0);
    const height = frame.readUInt32LE(4);
    const header = frame.length - width * height * 4;
    if (header < 12 || header > 16)
        throw new Error('Android raw framebuffer has an unknown layout');
    const hash = createHash('sha256');
    for (let row = Math.max(0, bounds.top); row < Math.min(height, bounds.bottom); row += 1) {
        const start = header + (row * width + Math.max(0, bounds.left)) * 4;
        hash.update(
            frame.subarray(
                start,
                start + (Math.min(width, bounds.right) - Math.max(0, bounds.left)) * 4,
            ),
        );
    }
    return hash.digest('hex');
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

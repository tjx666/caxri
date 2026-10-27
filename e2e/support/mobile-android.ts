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
import type { AndroidDisplayState } from '../../scripts/mobile-android-display-state.ts';
import { parseAndroidDisplayState } from '../../scripts/mobile-android-display-state.ts';

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

/**
 * Kills the app and launches it again, the way the OS reclaims a backgrounded app and the next open starts it fresh:
 * anything the app kept only in memory is gone.
 */
export async function coldStartMobileApp(serial: string): Promise<void> {
    await adbShell(serial, ['am', 'force-stop', 'com.caxri.mobile']);
    await adbShell(serial, ['am', 'start', '-W', 'com.caxri.mobile/.MainActivity']);
}

export const pushMobileFixture = (
    serial: string,
    localPath: string,
    remotePath: string,
): Promise<string> =>
    runMobileDeviceCommand(adb, ['-s', serial, 'push', localPath, remotePath], 'capture');

/**
 * Reads only a fixed native control's bounds; the raw accessibility tree never leaves the device probe. The query must
 * match exactly one node; `className` narrows a text that another node also exposes, such as a page title the WebView
 * reports as its own text.
 */
export async function mobileNativeControlBounds(
    serial: string,
    query: { className?: string; text?: string; resourceId?: string; imageTile?: number },
): Promise<ReturnType<typeof androidBounds>> {
    const dumpPath = '/data/local/tmp/caxri-acceptance-native.xml';
    let source: string;
    try {
        await adbShell(serial, ['uiautomator', 'dump', dumpPath]);
        source = await adbShell(serial, ['cat', dumpPath]);
    } catch {
        // A system window such as the Photo Picker can refuse one dump while it settles; the caller's bounded wait
        // treats that as "not visible yet" and dumps again instead of failing the whole case.
        return null;
    } finally {
        await adbShell(serial, ['rm', '-f', dumpPath]);
    }
    const candidates = source
        .matchAll(/<node\b[^>]*>/gu)
        .map(([node]) => node)
        .filter((node) => {
            if (query.imageTile !== undefined) {
                const tile = androidBounds(/\bbounds="([^"]+)"/u.exec(node)?.[1] ?? '');
                if (!tile || !node.includes('clickable="true"')) return false;
                const width = tile.right - tile.left;
                const height = tile.bottom - tile.top;
                return width >= 200 && height >= 200 && Math.abs(width - height) <= 2;
            }
            if (query.className && !node.includes(`class="${query.className}"`)) return false;
            const attribute = query.text ? 'text' : 'resource-id';
            const value = query.text ?? query.resourceId;
            return new RegExp(String.raw`\b${attribute}="([^"]*)"`, 'u').exec(node)?.[1] === value;
        })
        .toArray();
    // A Photo Picker grid lists its square tiles in reading order; any other query must name exactly one node.
    const node =
        query.imageTile === undefined
            ? candidates.length === 1 && candidates[0]
            : candidates[query.imageTile];
    if (!node) return null;
    if (!node.includes('enabled="true"')) return null;
    return androidBounds(/\bbounds="([^"]+)"/u.exec(node)?.[1] ?? '');
}

export async function tapMobileNativeControl(
    serial: string,
    query: { text?: string; resourceId?: string; imageTile?: number },
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

/**
 * Reads the sanitized semantic checks. Under heavy host load a single UIAutomator read once failed with no closed
 * reason in the middle of a case, so an unclassified driver failure is retried a few times; a closed reason such as a
 * lost foreground still fails at once, since a retry cannot fix it.
 */
export async function mobileSemantics(serial: string): Promise<MobileSemanticNode[]> {
    for (let attempt = 1; ; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop -- a retry only follows a failed read.
            const source = await runMobileDeviceCommand(
                'bun',
                ['run', androidDeviceScript, 'semantics', '--serial', serial],
                'capture',
            );
            return (JSON.parse(source) as { checks: MobileSemanticNode[] }).checks;
        } catch (error) {
            const isUnclassified =
                error instanceof Error && error.message.endsWith('(driver-failed)');
            if (!isUnclassified || attempt >= 3) throw error;
        }
        // eslint-disable-next-line no-await-in-loop -- see above.
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

/**
 * Compares native text inside the device helper and returns no text or raw accessibility XML. Like semantic capture,
 * this waits for UIAutomator idle and cannot observe a live streaming screen.
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
 * device bounds and prove the resulting product state separately. Semantic capture keeps only the first node per check
 * ID and carries no text, so a later row of an equal-height list (every tree row is `tree-row`) is reached with
 * `rowOffset`: the tap moves that many row heights below the first match.
 */
export async function tapMobileCheckByBounds(
    serial: string,
    checkId: string,
    { rowOffset = 0 }: { rowOffset?: number } = {},
): Promise<void> {
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
        String(
            Math.floor((bounds.top + bounds.bottom) / 2 + rowOffset * (bounds.bottom - bounds.top)),
        ),
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

interface FramebufferBounds {
    bottom: number;
    left: number;
    right: number;
    top: number;
}

/**
 * Reads one raw framebuffer. Raw `screencap` output is a small header followed by RGBA pixels; the header length
 * differs across Android releases, so it is derived from the size. Under heavy host load a capture taken while a sheet
 * animated came back short of a full frame, and the emulator once dropped offline for a moment, so a malformed or
 * failed read is retried a few times before failing.
 */
async function readRawFramebuffer(
    serial: string,
): Promise<{ frame: Buffer; header: number; height: number; width: number }> {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if (attempt > 0)
            // eslint-disable-next-line no-await-in-loop -- a retry only follows a malformed or failed capture.
            await new Promise((resolve) => setTimeout(resolve, 1000));
        let frame: Buffer;
        try {
            // eslint-disable-next-line no-await-in-loop -- see above.
            const result = await execFileAsync(adb, ['-s', serial, 'exec-out', 'screencap'], {
                cwd: projectRoot,
                encoding: 'buffer',
                maxBuffer: 32 * 1024 * 1024,
            });
            frame = result.stdout;
        } catch (error) {
            failure = error;
            continue;
        }
        if (frame.length < 8) continue;
        const width = frame.readUInt32LE(0);
        const height = frame.readUInt32LE(4);
        const header = frame.length - width * height * 4;
        if (header >= 12 && header <= 16) return { frame, header, height, width };
    }
    if (failure instanceof Error) throw failure;
    throw new Error('Android raw framebuffer has an unknown layout');
}

/**
 * Hashes only the framebuffer rows and columns inside `bounds`, so a status-bar clock or an unrelated animation
 * elsewhere on screen cannot make two frames of an unchanged region look different.
 */
export async function mobileRegionFingerprint(
    serial: string,
    bounds: FramebufferBounds,
): Promise<string> {
    const { frame, header, height, width } = await readRawFramebuffer(serial);
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

/**
 * The box around every pixel inside `bounds` within `tolerance` of `color` (`#rrggbb`) on each channel, or `undefined`
 * when none matches. It finds a control by its color on a screen UIAutomator cannot read because it never idles.
 */
export async function mobileColorBounds(
    serial: string,
    bounds: FramebufferBounds,
    color: string,
    tolerance = 24,
): Promise<FramebufferBounds | undefined> {
    const target = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16));
    const { frame, header, height, width } = await readRawFramebuffer(serial);
    let found: FramebufferBounds | undefined;
    for (let row = Math.max(0, bounds.top); row < Math.min(height, bounds.bottom); row += 1)
        for (
            let column = Math.max(0, bounds.left);
            column < Math.min(width, bounds.right);
            column += 1
        ) {
            const pixel = header + (row * width + column) * 4;
            if (
                target.every(
                    (value, channel) => Math.abs(frame[pixel + channel] - value) <= tolerance,
                )
            )
                found = found
                    ? {
                          bottom: Math.max(found.bottom, row + 1),
                          left: Math.min(found.left, column),
                          right: Math.max(found.right, column + 1),
                          top: Math.min(found.top, row),
                      }
                    : { bottom: row + 1, left: column, right: column + 1, top: row };
        }
    return found;
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

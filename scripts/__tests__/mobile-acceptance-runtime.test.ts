import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    assertMobileAcceptanceSourceIdentity,
    captureMobileAcceptanceCommand,
    clearAndroidAppDataIfInstalled,
    clearMobileAcceptanceCaseArtifacts,
    collectMobileAcceptanceArtifacts,
    createMobileAcceptanceArtifact,
    interruptAndroidScreenrecord,
    runMobileAcceptanceCommand,
    startMobileAcceptanceRecording,
    writeMobileAcceptanceReceipt,
} from '../mobile-acceptance-runtime';

const temporaryDirectories: string[] = [];
const VALID_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

describe('mobile Acceptance runtime', () => {
    it('rejects a different or dirty source tree before device work starts', () => {
        expect(() =>
            assertMobileAcceptanceSourceIdentity({
                actualCommit: 'b'.repeat(40),
                plannedCommit: 'a'.repeat(40),
                status: '',
            }),
        ).toThrow('does not match the frozen report commit');
        expect(() =>
            assertMobileAcceptanceSourceIdentity({
                actualCommit: 'a'.repeat(40),
                plannedCommit: 'a'.repeat(40),
                status: ' M scripts/mobile-android-acceptance.ts',
            }),
        ).toThrow('requires a clean source tree');
    });

    it('bounds every child command by both its stage and overall deadlines', () => {
        const spawn = vi.fn(() => ({ error: undefined, status: 0 }));
        runMobileAcceptanceCommand(
            {
                arguments: ['run', 'build'],
                command: 'bun',
                cwd: '/repo',
                deadlineMs: 11_000,
                nowMs: 1_000,
                timeoutMs: 30_000,
            },
            spawn as never,
        );
        expect(spawn).toHaveBeenCalledWith(
            'bun',
            ['run', 'build'],
            expect.objectContaining({ timeout: 10_000, killSignal: 'SIGTERM' }),
        );
    });

    it('atomically replaces a prior launch receipt during a clean retry', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-acceptance-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'receipt.json');
        await writeMobileAcceptanceReceipt(path, { launchId: 'launch-1', status: 'failed' });
        await writeMobileAcceptanceReceipt(path, { launchId: 'launch-2', status: 'passed' });

        await expect(readFile(path, 'utf8')).resolves.toContain('launch-2');
        await expect(readFile(path, 'utf8')).resolves.not.toContain('launch-1');
    });

    it('clears stale case evidence while preserving lifecycle history and other cases', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-acceptance-'));
        temporaryDirectories.push(directory);
        const assets = join(directory, 'assets');
        await mkdir(assets);
        await Promise.all([
            writeFile(join(assets, 'MOB-PAIR-01-desktop.png'), 'stale'),
            writeFile(join(assets, 'MOB-PAIR-01-scenario.txt'), 'stale'),
            writeFile(join(assets, 'MOB-PAIR-01-state-isolation.json'), 'history'),
            writeFile(join(assets, 'MOB-PAIR-02-android.png'), 'other'),
        ]);

        await clearMobileAcceptanceCaseArtifacts(directory, 'MOB-PAIR-01');

        await expect(readFile(join(assets, 'MOB-PAIR-01-desktop.png'))).rejects.toThrow();
        await expect(readFile(join(assets, 'MOB-PAIR-01-scenario.txt'))).rejects.toThrow();
        await expect(
            readFile(join(assets, 'MOB-PAIR-01-state-isolation.json'), 'utf8'),
        ).resolves.toBe('history');
        await expect(readFile(join(assets, 'MOB-PAIR-02-android.png'), 'utf8')).resolves.toBe(
            'other',
        );
    });

    it('captures binary device output without decoding or exposing it', () => {
        const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const spawn = vi.fn(() => ({ error: undefined, status: 0, stdout: image }));

        expect(
            captureMobileAcceptanceCommand(
                {
                    arguments: ['-s', 'emulator-5554', 'exec-out', 'screencap', '-p'],
                    command: '/sdk/adb',
                    cwd: '/repo',
                    deadlineMs: 11_000,
                    nowMs: 1_000,
                    timeoutMs: 30_000,
                },
                spawn as never,
            ),
        ).toEqual(image);
        expect(spawn).toHaveBeenCalledWith(
            '/sdk/adb',
            ['-s', 'emulator-5554', 'exec-out', 'screencap', '-p'],
            expect.objectContaining({ encoding: null, shell: false, stdio: 'pipe' }),
        );
    });

    it('hashes only valid framebuffer PNG evidence', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-capture-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'device.png');
        await writeFile(path, VALID_PNG);

        const artifact = await createMobileAcceptanceArtifact(path, {
            path: 'assets/MOB-ACC-02-android.png',
            source: 'android-framebuffer',
            type: 'screenshot',
        });
        expect(artifact).toMatchObject({
            path: 'assets/MOB-ACC-02-android.png',
            source: 'android-framebuffer',
            type: 'screenshot',
        });
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/u);

        await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));
        await expect(
            createMobileAcceptanceArtifact(path, {
                path: 'assets/MOB-ACC-02-android.png',
                source: 'android-framebuffer',
                type: 'screenshot',
            }),
        ).rejects.toThrow('decodable PNG');
    });

    it('captures the final screenshot after an earlier product failure and preserves that failure', async () => {
        const originalFailure = new Error('product check failed');
        const screenshot = {
            path: 'assets/MOB-ACC-02-android.png',
            sha256: 'a'.repeat(64),
            source: 'android-framebuffer' as const,
            type: 'screenshot' as const,
        };
        const captureScreenshot = vi.fn(() => Promise.resolve(screenshot));
        const captureRecording = vi.fn(() => Promise.reject(new Error('recording failed')));

        await expect(
            collectMobileAcceptanceArtifacts({
                captureRecording,
                captureScreenshot,
                failure: originalFailure,
            }),
        ).resolves.toEqual({ artifacts: [screenshot], failure: originalFailure });
        expect(captureScreenshot).toHaveBeenCalledOnce();
        expect(captureRecording).toHaveBeenCalledOnce();
    });

    it('owns one screen recording process and stops it idempotently', async () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses EventEmitter events.
        const child = new EventEmitter() as EventEmitter & {
            exitCode: number | null;
            kill: ReturnType<typeof vi.fn>;
            signalCode: NodeJS.Signals | null;
        };
        child.exitCode = null;
        child.signalCode = null;
        child.kill = vi.fn((signal: NodeJS.Signals) => {
            child.signalCode = signal;
            queueMicrotask(() => child.emit('exit', 0, signal));
            return true;
        });
        const spawn = vi.fn(() => {
            queueMicrotask(() => child.emit('spawn'));
            return child;
        });

        const recording = await startMobileAcceptanceRecording(
            {
                arguments: [
                    '-s',
                    'emulator-5554',
                    'shell',
                    'screenrecord',
                    '/data/local/tmp/caxri.mp4',
                ],
                command: '/sdk/adb',
                cwd: '/repo',
            },
            spawn as never,
        );
        await Promise.all([recording.stop(), recording.stop()]);

        expect(spawn).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledOnce();
        expect(child.kill).toHaveBeenCalledWith('SIGINT');
    });

    it.each([0, 1])('accepts Android screenrecord interrupt status %i', (status) => {
        const spawn = vi.fn(() => ({ error: undefined, status, stderr: '' }));

        interruptAndroidScreenrecord(
            {
                adb: '/sdk/adb',
                cwd: '/repo',
                serial: 'emulator-5554',
                timeoutMs: 30_000,
            },
            spawn as never,
        );

        expect(spawn).toHaveBeenCalledWith(
            '/sdk/adb',
            ['-s', 'emulator-5554', 'shell', 'pkill', '-INT', '-x', 'screenrecord'],
            expect.objectContaining({ shell: false, stdio: 'pipe', timeout: 30_000 }),
        );
    });

    it('rejects an unexpected Android screenrecord interrupt status', () => {
        const spawn = vi.fn(() => ({ error: undefined, status: 2, stderr: '' }));

        expect(() =>
            interruptAndroidScreenrecord(
                {
                    adb: '/sdk/adb',
                    cwd: '/repo',
                    serial: 'emulator-5554',
                    timeoutMs: 30_000,
                },
                spawn as never,
            ),
        ).toThrow('Android Acceptance recording interrupt failed');
    });

    it('rejects adb transport failure instead of treating it as no matching process', () => {
        const spawn = vi.fn(() => ({ error: undefined, status: 1, stderr: 'device offline' }));

        expect(() =>
            interruptAndroidScreenrecord(
                {
                    adb: '/sdk/adb',
                    cwd: '/repo',
                    serial: 'emulator-5554',
                    timeoutMs: 30_000,
                },
                spawn as never,
            ),
        ).toThrow('Android Acceptance recording interrupt failed');
    });

    it('waits for an Android-specific remote interrupt before returning', async () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses EventEmitter events.
        const child = new EventEmitter() as EventEmitter & {
            exitCode: number | null;
            kill: ReturnType<typeof vi.fn>;
            signalCode: NodeJS.Signals | null;
        };
        child.exitCode = null;
        child.signalCode = null;
        child.kill = vi.fn();
        const spawn = vi.fn(() => {
            queueMicrotask(() => child.emit('spawn'));
            return child;
        });
        const interrupt = vi.fn(() => {
            child.exitCode = 0;
            queueMicrotask(() => child.emit('exit', 0, null));
            return Promise.resolve();
        });

        const recording = await startMobileAcceptanceRecording(
            {
                arguments: ['shell', 'screenrecord', '/data/local/tmp/caxri.mp4'],
                command: '/sdk/adb',
                cwd: '/repo',
                interrupt,
            },
            spawn as never,
        );
        await recording.stop();

        expect(interrupt).toHaveBeenCalledOnce();
        expect(child.kill).not.toHaveBeenCalled();
    });

    it('falls back to local cleanup when the remote interrupt fails', async () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses EventEmitter events.
        const child = new EventEmitter() as EventEmitter & {
            exitCode: number | null;
            kill: ReturnType<typeof vi.fn>;
            signalCode: NodeJS.Signals | null;
        };
        child.exitCode = null;
        child.signalCode = null;
        child.kill = vi.fn((signal: NodeJS.Signals) => {
            child.signalCode = signal;
            queueMicrotask(() => child.emit('exit', 0, signal));
            return true;
        });
        const spawn = vi.fn(() => {
            queueMicrotask(() => child.emit('spawn'));
            return child;
        });
        const interrupt = vi.fn(() => Promise.reject(new Error('remote interrupt failed')));

        const recording = await startMobileAcceptanceRecording(
            {
                arguments: ['shell', 'screenrecord', '/data/local/tmp/caxri.mp4'],
                command: '/sdk/adb',
                cwd: '/repo',
                interrupt,
            },
            spawn as never,
        );

        await expect(recording.stop()).rejects.toThrow(
            'Mobile Acceptance recording interrupt failed',
        );
        expect(child.kill).toHaveBeenCalledWith('SIGINT');
    });

    it('does not interrupt a recording that already exited', async () => {
        // eslint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses EventEmitter events.
        const child = new EventEmitter() as EventEmitter & {
            exitCode: number | null;
            kill: ReturnType<typeof vi.fn>;
            signalCode: NodeJS.Signals | null;
        };
        child.exitCode = 0;
        child.signalCode = null;
        child.kill = vi.fn();
        const spawn = vi.fn(() => {
            queueMicrotask(() => child.emit('spawn'));
            return child;
        });
        const interrupt = vi.fn();

        const recording = await startMobileAcceptanceRecording(
            {
                arguments: ['shell', 'screenrecord', '/data/local/tmp/caxri.mp4'],
                command: '/sdk/adb',
                cwd: '/repo',
                interrupt,
            },
            spawn as never,
        );
        await recording.stop();

        expect(interrupt).not.toHaveBeenCalled();
        expect(child.kill).not.toHaveBeenCalled();
    });
});

describe('clearAndroidAppDataIfInstalled', () => {
    const appId = 'com.caxri.mobile';

    it('skips clearing when only a longer package id matches', () => {
        const runDevice = vi.fn().mockReturnValue('package:com.caxri.mobile.dev\n');
        expect(clearAndroidAppDataIfInstalled(appId, runDevice)).toBe('absent');
        expect(runDevice).toHaveBeenCalledTimes(1);
    });

    it('clears the data of an installed app', () => {
        const runDevice = vi
            .fn()
            .mockReturnValueOnce('package:com.caxri.mobile\r\n')
            .mockReturnValue('Success');
        expect(clearAndroidAppDataIfInstalled(appId, runDevice)).toBe('cleared');
        expect(runDevice).toHaveBeenLastCalledWith(['shell', 'pm', 'clear', appId]);
    });

    it('propagates a failed package query instead of reporting the app absent', () => {
        const runDevice = vi.fn(() => {
            throw new Error('device offline');
        });
        expect(() => clearAndroidAppDataIfInstalled(appId, runDevice)).toThrow('device offline');
    });
});

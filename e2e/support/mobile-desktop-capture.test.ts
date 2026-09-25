import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

import { execFileAsync } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import type { RunningCaxri } from './helpers';
import { createMobileDesktopCapture } from './mobile-desktop-capture';

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

interface MockDesktop {
    running: RunningCaxri;
    screenshotOptions: Array<{ style?: string }>;
    setScreenshotDelayMs(value: number): void;
    setTargetId(value: string): void;
}

function mockDesktop(profileDirectory: string): MockDesktop {
    let targetId = 'owned-renderer-target';
    let screenshotDelayMs = 0;
    const screenshotOptions: Array<{ style?: string }> = [];
    const row = {
        count: () => Promise.resolve(1),
        getAttribute: () => Promise.resolve('true'),
        screenshot: async (options: { style?: string }) => {
            screenshotOptions.push(options);
            if (screenshotDelayMs > 0) await sleep(screenshotDelayMs);
            return PNG;
        },
    };
    const page = {
        context: () => ({
            newCDPSession: () =>
                Promise.resolve({
                    send: () =>
                        Promise.resolve({ targetInfo: { targetId, type: 'page' as const } }),
                }),
        }),
        evaluate: () => Promise.resolve({ ok: true, result: { selectedSessionId: 'session-1' } }),
        isClosed: () => false,
        locator: (selector: string) =>
            selector.includes('[role="dialog"]') ? { count: () => Promise.resolve(0) } : row,
    };
    const app = {
        evaluate: () => Promise.resolve(profileDirectory),
        process: () => ({ pid: process.pid }),
    };
    return {
        running: { app, page } as unknown as RunningCaxri,
        screenshotOptions,
        setScreenshotDelayMs(value) {
            screenshotDelayMs = value;
        },
        setTargetId(value) {
            targetId = value;
        },
    };
}

async function fixture(
    verify: (input: { assetsDirectory: string; profileDirectory: string }) => Promise<void>,
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-desktop-capture-test-'));
    const assetsDirectory = join(directory, 'assets');
    const profileDirectory = join(directory, 'profile');
    await mkdir(profileDirectory);
    try {
        await verify({ assetsDirectory, profileDirectory });
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
}

describe('mobile Desktop capture', () => {
    it('binds two redacted row captures to one owned Desktop and writes its receipt after cleanup', async () => {
        await fixture(async ({ assetsDirectory, profileDirectory }) => {
            const desktop = mockDesktop(profileDirectory);
            const capture = await createMobileDesktopCapture({
                assetsDirectory,
                caseId: 'MOB-NEW-01',
                launchId: 'mobile-launch',
                profileDirectory,
                running: desktop.running,
                serial: 'emulator-5554',
                sourceCommit: COMMIT,
            });
            await capture.capture('before');
            await capture.capture('after');
            await expect(
                stat(join(assetsDirectory, 'MOB-NEW-01-desktop-capture.json')),
            ).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(capture.finalizeAfterCleanup({ cleanupConfirmed: false })).rejects.toThrow(
                'cleanup is unconfirmed',
            );
            await expect(capture.finalizeAfterCleanup({ cleanupConfirmed: true })).rejects.toThrow(
                'profile still exists',
            );
            await rm(profileDirectory, { force: true, recursive: true });
            const result = await capture.finalizeAfterCleanup({ cleanupConfirmed: true });
            const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8')) as {
                artifacts: Array<{ path: string; sha256: string; source: string }>;
                desktop: { pid: number; profileIdentity: string; targetId: string };
                launchId: string;
                selectedSessionIdentity: string;
                serial: string;
                sourceCommit: string;
            };
            expect(receipt).toMatchObject({
                launchId: 'mobile-launch',
                serial: 'emulator-5554',
                sourceCommit: COMMIT,
            });
            expect(receipt.desktop).toMatchObject({
                pid: process.pid,
                profileIdentity: createHash('sha256').update(profileDirectory).digest('hex'),
                targetId: 'owned-renderer-target',
            });
            expect(receipt.selectedSessionIdentity).toBe(
                createHash('sha256').update('session-1').digest('hex'),
            );
            expect(receipt.artifacts.map(({ path }) => path)).toEqual([
                'assets/MOB-NEW-01-desktop-before.png',
                'assets/MOB-NEW-01-desktop-after.png',
            ]);
            expect(
                receipt.artifacts.every(
                    ({ sha256, source }) =>
                        sha256 === createHash('sha256').update(PNG).digest('hex') &&
                        source === 'isolated-desktop-renderer',
                ),
            ).toBe(true);
            expect(desktop.screenshotOptions).toHaveLength(2);
            expect(desktop.screenshotOptions[0]?.style).toContain('visibility: hidden');
            expect(await readFile(result.receiptPath, 'utf8')).not.toContain(profileDirectory);
        });
    });

    it('rejects a changed CDP target before the second image and leaves no receipt', async () => {
        await fixture(async ({ assetsDirectory, profileDirectory }) => {
            const desktop = mockDesktop(profileDirectory);
            const capture = await createMobileDesktopCapture({
                assetsDirectory,
                caseId: 'MOB-NEW-01',
                launchId: 'mobile-launch',
                profileDirectory,
                running: desktop.running,
                serial: 'emulator-5554',
                sourceCommit: COMMIT,
            });
            await capture.capture('before');
            desktop.setTargetId('replacement-renderer-target');
            await expect(capture.capture('after')).rejects.toThrow('left the owned process');
            expect(desktop.screenshotOptions).toHaveLength(1);
            await expect(
                stat(join(assetsDirectory, 'MOB-NEW-01-desktop-capture.json')),
            ).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    it('records the full Desktop interval as bound video and rejects later media tampering', async () => {
        await fixture(async ({ assetsDirectory, profileDirectory }) => {
            const desktop = mockDesktop(profileDirectory);
            const capture = await createMobileDesktopCapture({
                assetsDirectory,
                caseId: 'MOB-E2E-01',
                launchId: 'journey-launch',
                profileDirectory,
                running: desktop.running,
                serial: 'emulator-5554',
                sourceCommit: COMMIT,
            });
            await capture.capture('before');
            await capture.startRecording();
            await sleep(3_100);
            const video = await capture.stopRecording();
            expect(await capture.stopRecording()).toEqual(video);
            expect(video).toMatchObject({
                path: 'assets/MOB-E2E-01-desktop.mp4',
                source: 'isolated-desktop-renderer',
                type: 'video',
            });
            await capture.capture('after');
            await rm(profileDirectory, { force: true, recursive: true });
            const videoPath = join(assetsDirectory, 'MOB-E2E-01-desktop.mp4');
            const bytes = await readFile(videoPath);
            await writeFile(videoPath, Buffer.from('tampered video'));
            await expect(capture.finalizeAfterCleanup({ cleanupConfirmed: true })).rejects.toThrow(
                'changed before receipt finalization',
            );
            await writeFile(videoPath, bytes);
            const result = await capture.finalizeAfterCleanup({ cleanupConfirmed: true });
            const receipt = JSON.parse(await readFile(result.receiptPath, 'utf8')) as {
                artifacts: Array<{ path: string; sha256: string }>;
                recording: {
                    actualSampleCount: number;
                    durationMs: number;
                    endedAt: string;
                    maxSampleGapMs: number;
                    sampleCount: number;
                    sampleRate: number;
                    startedAt: string;
                };
            };
            expect(receipt.artifacts.map(({ path }) => path)).toEqual([
                'assets/MOB-E2E-01-desktop-before.png',
                'assets/MOB-E2E-01-desktop-after.png',
                'assets/MOB-E2E-01-desktop.mp4',
            ]);
            expect(receipt.recording).toMatchObject({ sampleRate: 2 });
            expect(receipt.recording.durationMs).toBeGreaterThanOrEqual(3_000);
            expect(receipt.recording.sampleCount).toBe(
                Math.ceil(receipt.recording.durationMs / 500),
            );
            expect(receipt.recording.actualSampleCount).toBeGreaterThanOrEqual(2);
            expect(receipt.recording.maxSampleGapMs).toBeLessThanOrEqual(1_500);
            expect(
                Date.parse(receipt.recording.endedAt) - Date.parse(receipt.recording.startedAt),
            ).toBe(receipt.recording.durationMs);
            expect(bytes.toString('ascii', 4, 8)).toBe('ftyp');
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(video.sha256);
            const { stdout } = await execFileAsync('ffprobe', [
                '-v',
                'error',
                '-show_entries',
                'format=duration',
                '-of',
                'default=noprint_wrappers=1:nokey=1',
                videoPath,
            ]);
            const encodedDurationMs = Number(stdout.trim()) * 1_000;
            expect(encodedDurationMs - receipt.recording.durationMs).toBeGreaterThanOrEqual(0);
            expect(encodedDurationMs - receipt.recording.durationMs).toBeLessThan(500);
        });
    }, 30_000);

    it('aborts recording when the live Renderer target changes between sampled frames', async () => {
        await fixture(async ({ assetsDirectory, profileDirectory }) => {
            const desktop = mockDesktop(profileDirectory);
            const capture = await createMobileDesktopCapture({
                assetsDirectory,
                caseId: 'MOB-E2E-01',
                launchId: 'journey-launch',
                profileDirectory,
                running: desktop.running,
                serial: 'emulator-5554',
                sourceCommit: COMMIT,
            });
            await capture.capture('before');
            await capture.startRecording();
            desktop.setTargetId('replacement-renderer-target');
            await sleep(700);
            await expect(capture.stopRecording()).rejects.toThrow('left the owned process');
            await expect(
                stat(join(assetsDirectory, 'MOB-E2E-01-desktop.mp4')),
            ).rejects.toMatchObject({ code: 'ENOENT' });
        });
    });

    it('refuses to fill a long Renderer capture gap with repeated frames', async () => {
        await fixture(async ({ assetsDirectory, profileDirectory }) => {
            const desktop = mockDesktop(profileDirectory);
            const capture = await createMobileDesktopCapture({
                assetsDirectory,
                caseId: 'MOB-E2E-01',
                launchId: 'journey-launch',
                profileDirectory,
                running: desktop.running,
                serial: 'emulator-5554',
                sourceCommit: COMMIT,
            });
            await capture.capture('before');
            await capture.startRecording();
            desktop.setScreenshotDelayMs(1_650);
            await sleep(2_700);
            await expect(capture.stopRecording()).rejects.toThrow('unsampled Renderer interval');
            await expect(
                stat(join(assetsDirectory, 'MOB-E2E-01-desktop.mp4')),
            ).rejects.toMatchObject({ code: 'ENOENT' });
        });
    }, 15_000);
});

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { validateMobileEvidence } from './mobile-report';

const roots: string[] = [];
const caseId = 'MOB-E2E-01';
const commit = 'a'.repeat(40);
const launchId = 'launch-1';
const deviceId = 'emulator-5554';
const before = `assets/${caseId}-desktop-before.png`;
const after = `assets/${caseId}-desktop-after.png`;
const video = `assets/${caseId}-desktop.mp4`;
const androidVideo = `assets/${caseId}-android.mp4`;
const captureReceipt = `assets/${caseId}-desktop-capture.json`;
const deviceReceipt = `assets/${caseId}-mobile-device.json`;
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);
const VIDEO = Buffer.from('synthetic-video-bytes');
const hash = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
    const directories = [...roots];
    roots.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

describe('Acceptance Desktop recording receipt', () => {
    it('grants static-video validation only for exact E2E-1 recording identity and bytes', async () => {
        const parent = join(process.cwd(), '.records', '__test__');
        await mkdir(parent, { recursive: true });
        const directory = await mkdtemp(join(parent, 'desktop-video-'));
        roots.push(directory);
        await mkdir(join(directory, 'assets'));
        const receipt = {
            appId: 'com.caxri.mobile',
            artifacts: [
                {
                    path: before,
                    sha256: hash(PNG),
                    source: 'isolated-desktop-renderer',
                    type: 'screenshot',
                },
                {
                    path: after,
                    sha256: hash(PNG),
                    source: 'isolated-desktop-renderer',
                    type: 'screenshot',
                },
                {
                    path: video,
                    sha256: hash(VIDEO),
                    source: 'isolated-desktop-renderer',
                    type: 'video',
                },
            ],
            caseId,
            cleanup: { desktopProfile: 'removed' },
            desktop: {
                pid: 1234,
                processStartedAt: 'Fri Sep 25 12:00:00 2026',
                profileIdentity: 'b'.repeat(64),
                targetId: 'target-1',
            },
            launchId,
            recording: {
                actualSampleCount: 5,
                durationMs: 3_100,
                endedAt: '2026-09-25T12:00:03.100Z',
                maxSampleGapMs: 500,
                sampleCount: 7,
                sampleRate: 2,
                startedAt: '2026-09-25T12:00:00.000Z',
            },
            schemaVersion: 1,
            selectedSessionIdentity: 'c'.repeat(64),
            serial: deviceId,
            sourceCommit: commit,
        };
        const evidence = [
            { path: deviceReceipt },
            { path: captureReceipt },
            { path: androidVideo, source: 'android-framebuffer' as const },
            ...[before, after, video].map((path) => ({
                path,
                source: 'isolated-desktop-renderer' as const,
            })),
        ];
        const androidVideoSha256 = hash(VIDEO);
        await Promise.all([
            writeFile(join(directory, before), PNG),
            writeFile(join(directory, after), PNG),
            writeFile(join(directory, video), VIDEO),
            writeFile(join(directory, androidVideo), VIDEO),
            writeFile(join(directory, captureReceipt), JSON.stringify(receipt)),
            writeFile(
                join(directory, deviceReceipt),
                JSON.stringify({
                    appId: 'com.caxri.mobile',
                    artifacts: [
                        {
                            path: androidVideo,
                            sha256: androidVideoSha256,
                            source: 'android-framebuffer',
                            type: 'video',
                        },
                    ],
                    build: { identity: 'apk-sha256', mode: 'release' },
                    caseId,
                    cleanup: { appData: 'cleared', desktopProfile: 'isolated-and-removed' },
                    device: { id: deviceId, kind: 'emulator', platform: 'android' },
                    launchId,
                    outcome: 'full-journey-observed',
                    schemaVersion: 1,
                    sourceCommit: commit,
                    status: 'passed',
                }),
            ),
        ]);
        const validate = () =>
            validateMobileEvidence({
                caseId,
                device: { appId: 'com.caxri.mobile', deviceId, platform: 'android' },
                directory,
                evidence,
                evidenceBinding: { launchId },
                expectedStatus: 'passed',
                reportCommit: commit,
            });
        await expect(validate()).resolves.toEqual({
            longAndroidVideos: new Set([androidVideo]),
            staticDesktopVideos: new Map([[video, 3_100]]),
        });

        const originalDeviceReceipt = await readFile(join(directory, deviceReceipt), 'utf8');
        const parsedDeviceReceipt = JSON.parse(originalDeviceReceipt) as {
            cleanup: { appData: string; desktopProfile: string };
        };
        await writeFile(
            join(directory, deviceReceipt),
            JSON.stringify({
                ...parsedDeviceReceipt,
                cleanup: { ...parsedDeviceReceipt.cleanup, fixtureIme: 'pending' },
            }),
        );
        await expect(validate()).rejects.toThrow('fixture input method cleanup is incomplete');
        await writeFile(
            join(directory, deviceReceipt),
            JSON.stringify({
                ...parsedDeviceReceipt,
                cleanup: { ...parsedDeviceReceipt.cleanup, fixtureIme: 'restored' },
            }),
        );
        await expect(validate()).resolves.toEqual({
            longAndroidVideos: new Set([androidVideo]),
            staticDesktopVideos: new Map([[video, 3_100]]),
        });

        await writeFile(
            join(directory, captureReceipt),
            JSON.stringify({ ...receipt, recording: { ...receipt.recording, sampleCount: 8 } }),
        );
        await expect(validate()).rejects.toThrow('Desktop recording timeline is invalid');

        await writeFile(
            join(directory, captureReceipt),
            JSON.stringify({
                ...receipt,
                recording: { ...receipt.recording, maxSampleGapMs: 1_501 },
            }),
        );
        await expect(validate()).rejects.toThrow();

        await writeFile(join(directory, captureReceipt), JSON.stringify(receipt));
        await writeFile(join(directory, androidVideo), Buffer.from('tampered-android-video'));
        await expect(validate()).rejects.toThrow('mobile media evidence is not device-bound');
        await writeFile(join(directory, androidVideo), VIDEO);
        await writeFile(join(directory, video), Buffer.from('tampered-video'));
        await expect(validate()).rejects.toThrow('Desktop capture media hash does not match');
    });
});

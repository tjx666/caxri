import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UpdateState } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    canResumePartial,
    contentRangeStart,
    isResumedResponse,
    selectStaleUpdateFiles,
} from '../update-download-files';
import { detectVersionChange, recordLaunchVersion } from '../update-launch-version';
import {
    releasePageUrl,
    RESUME_CHECK_MIN_GAP_MS,
    shouldRunBackgroundCheck,
    UpdateService,
} from '../updates';

describe('selectStaleUpdateFiles', () => {
    it('keeps the current installer and its partial, drops other installers and partials', () => {
        const current = 'Caxri-0.0.5-arm64.dmg';
        expect(
            selectStaleUpdateFiles(
                [
                    current,
                    `${current}.part`,
                    'Caxri-0.0.4-arm64.dmg',
                    'Caxri-0.0.4-arm64.dmg.part',
                    'Caxri-0.0.5-arm64-nosourcemap.dmg',
                    'notes.txt',
                    'other.part',
                ],
                current,
            ),
        ).toEqual([
            'Caxri-0.0.4-arm64.dmg',
            'Caxri-0.0.4-arm64.dmg.part',
            'Caxri-0.0.5-arm64-nosourcemap.dmg',
        ]);
    });
});

describe('range resume helpers', () => {
    it('parses the first byte of a Content-Range header', () => {
        expect(contentRangeStart('bytes 100-199/200')).toBe(100);
        expect(contentRangeStart('bytes 100-199/*')).toBe(100);
        expect(contentRangeStart('bytes */200')).toBeUndefined();
        expect(contentRangeStart(null)).toBeUndefined();
    });

    it('resumes only a non-empty partial smaller than the expected size', () => {
        expect(canResumePartial(0, 100)).toBe(false);
        expect(canResumePartial(50, 100)).toBe(true);
        expect(canResumePartial(100, 100)).toBe(false);
        expect(canResumePartial(50, undefined)).toBe(true);
    });

    it('accepts only a 206 that starts at the requested offset', () => {
        const range = (status: number, header: string | null) => ({
            status,
            headers: { get: () => header },
        });
        expect(isResumedResponse(range(206, 'bytes 50-99/100'), 50)).toBe(true);
        expect(isResumedResponse(range(206, 'bytes 0-99/100'), 50)).toBe(false);
        expect(isResumedResponse(range(200, null), 50)).toBe(false);
    });
});

describe('version change detection', () => {
    it('announces only a recorded, different version', () => {
        expect(detectVersionChange(undefined, '0.2.0')).toBeUndefined();
        expect(detectVersionChange('0.2.0', '0.2.0')).toBeUndefined();
        expect(detectVersionChange('0.1.0', '0.2.0')).toBe('0.1.0');
    });

    it('stays silent on first install, then reports the replaced version once', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-launch-version-'));
        try {
            expect(await recordLaunchVersion(directory, '0.1.0')).toBeUndefined();
            expect(await recordLaunchVersion(directory, '0.1.0')).toBeUndefined();
            expect(await recordLaunchVersion(directory, '0.2.0')).toBe('0.1.0');
            expect(await recordLaunchVersion(directory, '0.2.0')).toBeUndefined();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});

describe('release page and background check policy', () => {
    it('accepts only this repository release pages', () => {
        expect(releasePageUrl('https://github.com/tjx666/caxri/releases/tag/v0.2.0')).toBe(
            'https://github.com/tjx666/caxri/releases/tag/v0.2.0',
        );
        expect(releasePageUrl('https://evil.example/tjx666/caxri/releases')).toBeUndefined();
        expect(releasePageUrl('https://github.com/other/repo/releases/tag/v1')).toBeUndefined();
        expect(releasePageUrl(undefined)).toBeUndefined();
    });

    it('never re-checks over a download, a ready installer, or a check in flight', () => {
        const base = {
            isCheckInFlight: false,
            lastAttemptAt: undefined,
            minGapMs: 0,
            now: 1_000,
            status: 'up-to-date' as UpdateState['status'],
        };
        expect(shouldRunBackgroundCheck(base)).toBe(true);
        expect(shouldRunBackgroundCheck({ ...base, status: 'downloading' })).toBe(false);
        expect(shouldRunBackgroundCheck({ ...base, status: 'ready' })).toBe(false);
        expect(shouldRunBackgroundCheck({ ...base, isCheckInFlight: true })).toBe(false);
    });

    it('throttles a wake-from-sleep check that follows a recent attempt', () => {
        const base = {
            isCheckInFlight: false,
            minGapMs: RESUME_CHECK_MIN_GAP_MS,
            status: 'idle' as UpdateState['status'],
        };
        expect(shouldRunBackgroundCheck({ ...base, lastAttemptAt: 0, now: 60_000 })).toBe(false);
        expect(
            shouldRunBackgroundCheck({
                ...base,
                lastAttemptAt: 0,
                now: RESUME_CHECK_MIN_GAP_MS,
            }),
        ).toBe(true);
    });
});

const temporaryDirectories: string[] = [];
afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

function serviceFor(directory: string, dmg: Uint8Array, isRangeSupported: boolean) {
    const fileName = 'Caxri-0.0.4-arm64.dmg';
    const digest = createHash('sha256').update(dmg).digest('hex');
    const requests: Array<{ range: string | null; url: string }> = [];
    const fetch = vi.fn((input: string, init?: RequestInit): Promise<Response> => {
        const range = new Headers(init?.headers).get('range');
        requests.push({ range, url: input });
        if (input.includes('/releases/latest'))
            return Promise.resolve(
                Response.json({
                    tag_name: 'v0.0.4',
                    html_url: 'https://github.com/tjx666/caxri/releases/tag/v0.0.4',
                    draft: false,
                    prerelease: false,
                    assets: [fileName, `${fileName}.sha256`].map((name) => ({
                        name,
                        size: name.endsWith('.sha256') ? 96 : dmg.byteLength,
                        browser_download_url: `https://github.com/tjx666/caxri/releases/download/v0.0.4/${name}`,
                    })),
                }),
            );
        if (input.endsWith('.sha256'))
            return Promise.resolve(new Response(`${digest}  ${fileName}\n`));
        if (range && isRangeSupported) {
            const start = Number(/bytes=(\d+)-/.exec(range)?.[1]);
            const tail = Uint8Array.from(dmg.subarray(start));
            return Promise.resolve(
                new Response(tail.buffer, {
                    status: 206,
                    headers: {
                        'content-length': String(tail.byteLength),
                        'content-range': `bytes ${start}-${dmg.byteLength - 1}/${dmg.byteLength}`,
                    },
                }),
            );
        }
        return Promise.resolve(
            new Response(Uint8Array.from(dmg).buffer, {
                headers: { 'content-length': String(dmg.byteLength) },
            }),
        );
    });
    const service = new UpdateService({
        currentVersion: '0.0.3',
        downloadDirectory: directory,
        enabled: true,
        fetch,
        openPath: () => Promise.resolve(''),
    });
    return { fileName, requests, service };
}

async function freshDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-update-files-'));
    temporaryDirectories.push(directory);
    return directory;
}

describe('UpdateService download files', () => {
    const dmg = Buffer.from('0123456789abcdefghij'.repeat(5));

    it('carries the release page into the state and deletes stale installers', async () => {
        const directory = await freshDirectory();
        await writeFile(join(directory, 'Caxri-0.0.1-arm64.dmg'), 'old');
        await writeFile(join(directory, 'Caxri-0.0.2-arm64.dmg.part'), 'old');
        const { service } = serviceFor(directory, dmg, false);
        await expect(service.check()).resolves.toMatchObject({
            releaseUrl: 'https://github.com/tjx666/caxri/releases/tag/v0.0.4',
        });
        await expect(service.download()).resolves.toMatchObject({ status: 'ready' });
        expect(await readdir(directory)).toEqual(['Caxri-0.0.4-arm64.dmg']);
    });

    it('reuses a verified installer without downloading it again', async () => {
        const directory = await freshDirectory();
        const { fileName, requests, service } = serviceFor(directory, dmg, false);
        await writeFile(join(directory, fileName), dmg);
        await service.check();
        await expect(service.download()).resolves.toMatchObject({ status: 'ready' });
        expect(requests.filter((request) => request.url.endsWith('.dmg'))).toHaveLength(0);
    });

    it('resumes a partial file with a Range request when the server supports it', async () => {
        const directory = await freshDirectory();
        const { fileName, requests, service } = serviceFor(directory, dmg, true);
        await writeFile(join(directory, `${fileName}.part`), dmg.subarray(0, 40));
        await service.check();
        await expect(service.download()).resolves.toMatchObject({ status: 'ready' });
        expect(requests.find((request) => request.url.endsWith('.dmg'))?.range).toBe('bytes=40-');
    });

    it('falls back to a full download when the server ignores Range', async () => {
        const directory = await freshDirectory();
        const { fileName, service } = serviceFor(directory, dmg, false);
        await writeFile(join(directory, `${fileName}.part`), dmg.subarray(0, 40));
        await service.check();
        await expect(service.download()).resolves.toMatchObject({ status: 'ready' });
    });

    it('stamps the replaced version until it is acknowledged', async () => {
        const directory = await freshDirectory();
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: false,
            openPath: () => Promise.resolve(''),
        });
        expect(service.getState()).not.toHaveProperty('updatedFrom');
        service.announceUpdatedFrom('0.0.2');
        expect(service.getState()).toMatchObject({ updatedFrom: '0.0.2' });
        await service.acknowledge();
        expect(service.getState()).not.toHaveProperty('updatedFrom');
    });
});

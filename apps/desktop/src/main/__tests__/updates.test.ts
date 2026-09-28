import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UpdateState } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { shouldStartAutomaticUpdateCheck, UpdateService, updateStateLogFields } from '../updates';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'caxri-updates-test-'));
    temporaryDirectories.push(path);
    return path;
}

afterEach(async () => {
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
});

function assetUrl(version: string, name: string): string {
    return `https://github.com/tjx666/caxri/releases/download/v${version}/${name}`;
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
    return Uint8Array.from(bytes).buffer;
}

function releaseResponse(version: string, dmg: Uint8Array, names?: string[]): Response {
    const fileName = `Caxri-${version}-arm64.dmg`;
    const assetNames = names ?? [fileName, `${fileName}.sha256`];
    return Response.json({
        tag_name: `v${version}`,
        draft: false,
        prerelease: false,
        assets: assetNames.map((name) => ({
            name,
            size: name.endsWith('.sha256') ? 96 : dmg.byteLength,
            browser_download_url: assetUrl(version, name),
        })),
    });
}

function releaseFetch(
    version: string,
    dmg: Uint8Array,
    checksum = createHash('sha256').update(dmg).digest('hex'),
) {
    const fileName = `Caxri-${version}-arm64.dmg`;
    return vi.fn((input: string): Promise<Response> => {
        if (input.includes('/releases/latest'))
            return Promise.resolve(releaseResponse(version, dmg));
        if (input.endsWith('.sha256'))
            return Promise.resolve(
                new Response(`${checksum}  ${fileName}\n`, {
                    headers: { 'content-length': '96' },
                }),
            );
        if (input.endsWith('.dmg'))
            return Promise.resolve(
                new Response(responseBody(dmg), {
                    headers: { 'content-length': String(dmg.byteLength) },
                }),
            );
        return Promise.resolve(new Response(null, { status: 404 }));
    });
}

describe('automatic update policy', () => {
    it('does not make external requests from a packaged E2E profile', () => {
        expect(
            shouldStartAutomaticUpdateCheck({
                alreadyStarted: false,
                isE2E: true,
                isPackaged: true,
            }),
        ).toBe(false);
        expect(
            shouldStartAutomaticUpdateCheck({
                alreadyStarted: false,
                isE2E: false,
                isPackaged: true,
            }),
        ).toBe(true);
    });

    it('runs one off-network launch check for an admitted Acceptance fixture', () => {
        expect(
            shouldStartAutomaticUpdateCheck({
                alreadyStarted: false,
                hasAcceptanceDiscovery: true,
                isE2E: true,
                isPackaged: false,
            }),
        ).toBe(true);
        expect(
            shouldStartAutomaticUpdateCheck({
                alreadyStarted: true,
                hasAcceptanceDiscovery: true,
                isE2E: true,
                isPackaged: false,
            }),
        ).toBe(false);
        expect(
            shouldStartAutomaticUpdateCheck({
                alreadyStarted: false,
                isE2E: true,
                isPackaged: false,
            }),
        ).toBe(false);
    });
});

describe('Acceptance update discovery', () => {
    function acceptanceService(version = '999.0.0') {
        const states: UpdateState[] = [];
        const fetch = vi.fn<(input: string) => Promise<Response>>();
        const openPath = vi.fn(() => Promise.resolve(''));
        const discover = vi.fn(() =>
            Promise.resolve({ fileName: `Caxri-${version}-arm64.dmg`, version }),
        );
        const service = new UpdateService({
            acceptanceDiscovery: { discover },
            currentVersion: '0.0.76',
            downloadDirectory: '/unused',
            enabled: false,
            fetch,
            onState: (state) => states.push(state),
            openPath,
        });
        return { discover, fetch, openPath, service, states };
    }

    it('announces the fixed release through the normal state stream without any network request', async () => {
        const { discover, fetch, service, states } = acceptanceService();

        service.startAutomaticCheck({ isE2E: true });
        service.startAutomaticCheck({ isE2E: true });
        await vi.waitFor(() => expect(service.getState().status).toBe('available'));
        // A manual check after the launch check re-reads the served state rather than consuming the fixture again.
        await expect(service.check({ manual: true })).resolves.toMatchObject({
            status: 'available',
            version: '999.0.0',
        });

        expect(discover).toHaveBeenCalledOnce();
        expect(fetch).not.toHaveBeenCalled();
        expect(states).toEqual([
            { status: 'checking', currentVersion: '0.0.76' },
            {
                status: 'available',
                currentVersion: '0.0.76',
                version: '999.0.0',
                fileName: 'Caxri-999.0.0-arm64.dmg',
                announced: false,
            },
        ]);
    });

    it('keeps download and install disabled for the fixture release', async () => {
        const { fetch, openPath, service } = acceptanceService();
        await service.check({ manual: true });

        await expect(service.download()).resolves.toMatchObject({
            status: 'error',
            action: 'download',
            message: 'Update downloads are disabled in Acceptance launches.',
            version: '999.0.0',
        });
        await expect(service.open()).resolves.toMatchObject({
            status: 'error',
            action: 'download',
        });
        expect(fetch).not.toHaveBeenCalled();
        expect(openPath).not.toHaveBeenCalled();
    });

    it('restores the served release when a check follows the disabled download', async () => {
        const { discover, service } = acceptanceService();
        await service.check({ manual: true });
        await service.download();

        await expect(service.check({ manual: true })).resolves.toMatchObject({
            status: 'available',
            version: '999.0.0',
            fileName: 'Caxri-999.0.0-arm64.dmg',
        });
        expect(discover).toHaveBeenCalledOnce();
    });

    it('surfaces a rejected fixture request as a check error instead of the packaged-only notice', async () => {
        const service = new UpdateService({
            acceptanceDiscovery: {
                discover: () =>
                    Promise.reject(
                        new Error(
                            'The Acceptance update fixture request was rejected (unknown-fixture).',
                        ),
                    ),
            },
            currentVersion: '0.0.76',
            downloadDirectory: '/unused',
            enabled: false,
            openPath: () => Promise.resolve(''),
        });
        await expect(service.check()).resolves.toMatchObject({
            status: 'error',
            action: 'check',
            message: 'The Acceptance update fixture request was rejected (unknown-fixture).',
        });
    });

    it('rejects a fixture release that is not newer than the running build', async () => {
        const { service } = acceptanceService('0.0.76');
        await expect(service.check()).resolves.toMatchObject({
            status: 'error',
            action: 'check',
            message: 'The Acceptance update fixture must be newer than this build.',
        });
    });

    it('never starts an automatic check for an unpackaged build without the fixture', () => {
        const fetch = vi.fn<(input: string) => Promise<Response>>();
        const service = new UpdateService({
            currentVersion: '0.0.76',
            downloadDirectory: '/unused',
            enabled: false,
            fetch,
            openPath: () => Promise.resolve(''),
        });
        service.startAutomaticCheck({ isE2E: false });
        expect(service.getState().status).toBe('idle');
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('update state log fields', () => {
    it('carries the diagnostic context for error and unavailable states', () => {
        expect(
            updateStateLogFields({
                status: 'error',
                failureKind: 'network',
                currentVersion: '0.0.3',
                action: 'check',
                message: 'The GitHub release check failed with status 404.',
            }),
        ).toEqual({
            status: 'error',
            failureKind: 'network',
            action: 'check',
            message: 'The GitHub release check failed with status 404.',
        });
        expect(
            updateStateLogFields({
                status: 'unavailable',
                currentVersion: '0.0.3',
                reason: 'The Caxri release feed is not publicly available yet.',
            }),
        ).toEqual({
            status: 'unavailable',
            reason: 'The Caxri release feed is not publicly available yet.',
            rateLimited: 'false',
            retryAt: null,
        });
        expect(
            updateStateLogFields({
                status: 'unavailable',
                currentVersion: '0.0.3',
                reason: 'Update checks are rate limited by GitHub right now.',
                rateLimited: true,
                retryAt: Date.UTC(2026, 0, 2, 12, 0, 0),
            }),
        ).toEqual({
            status: 'unavailable',
            reason: 'Update checks are rate limited by GitHub right now.',
            rateLimited: 'true',
            retryAt: '2026-01-02T12:00:00.000Z',
        });
        expect(
            updateStateLogFields({
                status: 'available',
                currentVersion: '0.0.3',
                version: '0.0.4',
                fileName: 'Caxri-0.0.4-arm64.dmg',
            }),
        ).toEqual({ status: 'available', version: '0.0.4' });
    });
});

describe('UpdateService', () => {
    it('downloads the exact arm64 asset, verifies SHA-256, and opens the internal path', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('verified dmg fixture');
        const fetch = releaseFetch('0.0.4', dmg);
        const openPath = vi.fn(() => Promise.resolve(''));
        const onState = vi.fn();
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            openPath,
            onState,
        });

        await expect(service.check()).resolves.toMatchObject({
            status: 'available',
            version: '0.0.4',
        });
        await expect(service.download()).resolves.toMatchObject({
            status: 'ready',
            version: '0.0.4',
        });

        const finalPath = join(directory, 'Caxri-0.0.4-arm64.dmg');
        await expect(readFile(finalPath)).resolves.toEqual(Buffer.from(dmg));
        await expect(service.open()).resolves.toMatchObject({ status: 'ready' });
        expect(openPath).toHaveBeenCalledWith(finalPath);
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
            'https://api.github.com/repos/tjx666/caxri/releases/latest',
            assetUrl('0.0.4', 'Caxri-0.0.4-arm64.dmg.sha256'),
            assetUrl('0.0.4', 'Caxri-0.0.4-arm64.dmg'),
        ]);
        expect(onState).toHaveBeenCalledWith(expect.objectContaining({ status: 'downloading' }));
    });

    it('deletes the partial download when checksum verification fails', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('tampered dmg fixture');
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch: releaseFetch('0.0.4', dmg, '0'.repeat(64)),
            openPath: () => Promise.resolve(''),
        });

        await service.check();
        const result = await service.download();
        expect(result.status).toBe('error');
        if (result.status !== 'error') throw new Error('Expected a download error');
        expect(result.action).toBe('download');
        expect(result.failureKind).toBe('integrity');
        expect(result.message).toContain('SHA-256');
        await expect(access(join(directory, 'Caxri-0.0.4-arm64.dmg.part'))).rejects.toThrow();
        await expect(access(join(directory, 'Caxri-0.0.4-arm64.dmg'))).rejects.toThrow();
    });

    it('rejects releases that do not contain the exact versioned assets', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        const fetch = vi.fn(() =>
            Promise.resolve(
                releaseResponse('0.0.4', dmg, [
                    'Caxri-latest-arm64.dmg',
                    'Caxri-latest-arm64.dmg.sha256',
                ]),
            ),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        const result = await service.check();
        expect(result.status).toBe('error');
        if (result.status !== 'error') throw new Error('Expected a release check error');
        expect(result.action).toBe('check');
        expect(result.message).toContain('missing its arm64 DMG');
    });

    it('degrades a 404 release feed to unavailable instead of a permanent error', async () => {
        const directory = await temporaryDirectory();
        const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        const result = await service.check();
        expect(result.status).toBe('unavailable');
        if (result.status !== 'unavailable') throw new Error('Expected an unavailable state');
        expect(result.reason).toContain('not publicly available');
    });

    it('degrades a 403 primary rate limit to unavailable and remembers the reset time', async () => {
        const directory = await temporaryDirectory();
        const nowMs = 1_700_000_000_000;
        const resetEpochSeconds = Math.floor(nowMs / 1_000) + 600;
        const fetch = vi.fn(() =>
            Promise.resolve(
                new Response(null, {
                    status: 403,
                    headers: { 'x-ratelimit-reset': String(resetEpochSeconds) },
                }),
            ),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            now: () => nowMs,
            openPath: () => Promise.resolve(''),
        });

        const result = await service.check();
        expect(result.status).toBe('unavailable');
        if (result.status !== 'unavailable') throw new Error('Expected an unavailable state');
        expect(result.reason).toContain('rate limited');
        // The resume time reaches the Renderer instead of being computed and dropped: it is the only thing that turns
        // an unexplained disabled button into a wait the user can plan around.
        expect(result.rateLimited).toBe(true);
        expect(result.retryAt).toBe(resetEpochSeconds * 1_000);

        // A second check inside the reset window must not call fetch again.
        const secondResult = await service.check();
        expect(fetch).toHaveBeenCalledOnce();
        expect(secondResult.status).toBe('unavailable');
        if (secondResult.status !== 'unavailable') throw new Error('Expected an unavailable state');
        expect(secondResult.reason).toContain('rate limited');
        expect(secondResult.retryAt).toBe(resetEpochSeconds * 1_000);

        // A user-initiated check bypasses the local window and hits the network again.
        await service.check({ manual: true });
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('degrades a 429 secondary rate limit to unavailable using retry-after', async () => {
        const directory = await temporaryDirectory();
        const nowMs = 1_700_000_000_000;
        const fetch = vi.fn(() =>
            Promise.resolve(new Response(null, { status: 429, headers: { 'retry-after': '30' } })),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            now: () => nowMs,
            openPath: () => Promise.resolve(''),
        });

        const result = await service.check();
        expect(result.status).toBe('unavailable');
        if (result.status !== 'unavailable') throw new Error('Expected an unavailable state');
        expect(result.reason).toContain('rate limited');
        expect(result.rateLimited).toBe(true);
        expect(result.retryAt).toBe(nowMs + 30_000);
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('retries the network once the rate limit window has elapsed', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        let nowMs = 1_700_000_000_000;
        const resetEpochSeconds = Math.floor(nowMs / 1_000) + 60;
        const rateLimited = vi.fn(() =>
            Promise.resolve(
                new Response(null, {
                    status: 429,
                    headers: { 'x-ratelimit-reset': String(resetEpochSeconds) },
                }),
            ),
        );
        const succeed = releaseFetch('0.0.4', dmg);
        const fetch = vi.fn((input: string): Promise<Response> =>
            fetch.mock.calls.length === 1 ? rateLimited() : succeed(input),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            now: () => nowMs,
            openPath: () => Promise.resolve(''),
        });

        const first = await service.check();
        expect(first.status).toBe('unavailable');

        // Still inside the window: no additional network call.
        await service.check();
        expect(fetch).toHaveBeenCalledOnce();

        // Move past the recorded reset time and retry.
        nowMs = resetEpochSeconds * 1_000 + 1;
        const afterWindow = await service.check();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(afterWindow.status).toBe('available');
    });

    it('keeps non-404 release check failures as diagnosable errors', async () => {
        const directory = await temporaryDirectory();
        const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 500 })));
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        const result = await service.check();
        expect(result.status).toBe('error');
        if (result.status !== 'error') throw new Error('Expected a release check error');
        expect(result.action).toBe('check');
        expect(result.message).toContain('status 500');
        expect(result.failureKind).toBe('network');
    });

    it('coalesces concurrent checks into one GitHub request', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        const { promise: pendingResponse, resolve: resolveResponse } =
            Promise.withResolvers<Response>();
        const fetch = vi.fn(() => pendingResponse);
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        const first = service.check();
        const second = service.check();
        expect(first).toBe(second);
        expect(fetch).toHaveBeenCalledOnce();
        resolveResponse(releaseResponse('0.0.4', dmg));
        await expect(first).resolves.toMatchObject({ status: 'available' });
    });

    it('cancels an active download and returns to the available state', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        const baseFetch = releaseFetch('0.0.4', dmg);
        const fetch = vi.fn((input: string, init?: RequestInit): Promise<Response> => {
            if (!input.endsWith('.dmg')) return baseFetch(input);
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('Canceled', 'AbortError')),
                    { once: true },
                );
            });
        });
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        await service.check();
        const download = service.download();
        const duplicate = service.download();
        expect(duplicate).toBe(download);
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
        await expect(service.cancel()).resolves.toMatchObject({ status: 'available' });
        await expect(download).resolves.toMatchObject({ status: 'available' });
    });

    it('keeps update network access disabled in unpackaged builds', async () => {
        const fetch = vi.fn();
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: await temporaryDirectory(),
            enabled: false,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        await expect(service.check()).resolves.toMatchObject({ status: 'unavailable' });
        expect(fetch).not.toHaveBeenCalled();
    });
});

describe('UpdateService announcement bookkeeping', () => {
    it('marks a fresh release unannounced, and every later read of it announced', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        const onState = vi.fn();
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch: releaseFetch('0.0.4', dmg),
            openPath: () => Promise.resolve(''),
            onState,
        });

        const discovered = await service.check();
        expect(discovered).toMatchObject({ status: 'available', announced: false });
        expect(onState).toHaveBeenCalledWith(expect.objectContaining({ announced: false }));

        await expect(service.acknowledge()).resolves.toMatchObject({ announced: true });
        // A window reload re-reads the same state and must not find a fresh discovery.
        expect(service.getState()).toMatchObject({ status: 'available', announced: true });
    });

    it('does not turn a cancelled download back into a fresh prompt', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        const baseFetch = releaseFetch('0.0.4', dmg);
        const fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
            if (!input.endsWith('.dmg')) return baseFetch(input);
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('Canceled', 'AbortError')),
                    { once: true },
                );
            });
        });
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        await service.check();
        await service.acknowledge();
        const download = service.download();
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
        await expect(service.cancel()).resolves.toMatchObject({
            status: 'available',
            announced: true,
        });
        await download;
    });

    it('announces a newer release again after the previous one was acknowledged', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        let version = '0.0.4';
        const fetch = vi.fn((input: string): Promise<Response> =>
            releaseFetch(version, dmg)(input),
        );
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        await service.check();
        await service.acknowledge();
        version = '0.0.5';
        await expect(service.check()).resolves.toMatchObject({
            status: 'available',
            version: '0.0.5',
            announced: false,
        });
    });

    it('leaves a non-available status untouched', async () => {
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: await temporaryDirectory(),
            enabled: false,
            fetch: vi.fn(),
            openPath: () => Promise.resolve(''),
        });

        await service.check();
        await expect(service.acknowledge()).resolves.toMatchObject({ status: 'unavailable' });
    });
});

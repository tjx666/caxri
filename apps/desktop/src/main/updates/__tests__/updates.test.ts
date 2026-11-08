import { Buffer } from 'node:buffer';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    assetUrl,
    releaseFetch,
    releaseResponse,
    removeTemporaryDirectories,
    temporaryDirectory,
} from '../../__tests__/support/update-service-harness';
import { shouldStartAutomaticUpdateCheck } from '../discovery/background-check';
import { updateStateLogFields } from '../update-state-log';
import { UpdateService } from '../updates';

afterEach(removeTemporaryDirectories);

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
            messageLength: 'The GitHub release check failed with status 404.'.length,
        });
        expect(
            updateStateLogFields({
                status: 'unavailable',
                currentVersion: '0.0.3',
                reason: 'feed-unavailable',
            }),
        ).toEqual({
            status: 'unavailable',
            reason: 'feed-unavailable',
            retryAt: null,
        });
        expect(
            updateStateLogFields({
                status: 'unavailable',
                currentVersion: '0.0.3',
                reason: 'rate-limited',
                retryAt: Date.UTC(2026, 0, 2, 12, 0, 0),
            }),
        ).toEqual({
            status: 'unavailable',
            reason: 'rate-limited',
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

    it('marks an update without an in-place installer as manual, so the DMG stays the way in', async () => {
        const directory = await temporaryDirectory();
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch: releaseFetch('0.0.4', new TextEncoder().encode('dmg')),
            openPath: vi.fn(() => Promise.resolve('')),
        });

        await service.check();
        await expect(service.download()).resolves.toMatchObject({
            status: 'ready',
            installMode: 'manual',
        });
        await expect(service.applyOnExit({ relaunch: false })).resolves.toBe(false);
        await expect(service.install()).resolves.toMatchObject({
            status: 'error',
            action: 'install',
            version: '0.0.4',
        });
    });

    it('unpacks the verified download for Restart to Update and installs it on exit', async () => {
        const directory = await temporaryDirectory();
        const prepareInstall = vi.fn(() => Promise.resolve({ installMode: 'restart' as const }));
        const launchInstall = vi.fn(() => Promise.resolve());
        const restartToUpdate = vi.fn(() => Promise.resolve());
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch: releaseFetch('0.0.4', new TextEncoder().encode('dmg')),
            launchInstall,
            openPath: vi.fn(() => Promise.resolve('')),
            prepareInstall,
            restartToUpdate,
        });

        await service.check();
        await expect(service.download()).resolves.toMatchObject({
            status: 'ready',
            installMode: 'restart',
        });
        expect(prepareInstall).toHaveBeenCalledWith({
            dmgPath: join(directory, 'Caxri-0.0.4-arm64.dmg'),
            version: '0.0.4',
        });

        // `install` hands over to the quit flow; it only returns when the user cancelled.
        await expect(service.install()).resolves.toMatchObject({ status: 'ready' });
        expect(restartToUpdate).toHaveBeenCalledOnce();
        expect(launchInstall).not.toHaveBeenCalled();

        // A check while the restart is being confirmed must not replace the staged update with a fresh `available`.
        await expect(service.check()).resolves.toMatchObject({ status: 'ready' });

        await expect(service.applyOnExit({ relaunch: true })).resolves.toBe(true);
        expect(launchInstall).toHaveBeenCalledWith({ relaunch: true, version: '0.0.4' });
    });

    it('falls back to the manual install when unpacking throws', async () => {
        const directory = await temporaryDirectory();
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch: releaseFetch('0.0.4', new TextEncoder().encode('dmg')),
            launchInstall: vi.fn(() => Promise.resolve()),
            openPath: vi.fn(() => Promise.resolve('')),
            prepareInstall: vi.fn(() => Promise.reject(new Error('hdiutil failed'))),
        });

        await service.check();
        await expect(service.download()).resolves.toMatchObject({ installMode: 'manual' });
        await expect(service.applyOnExit({ relaunch: false })).resolves.toBe(false);
    });

    it('acknowledges the ready offer separately from the available one', async () => {
        const directory = await temporaryDirectory();
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: directory,
            enabled: true,
            fetch: releaseFetch('0.0.4', new TextEncoder().encode('dmg')),
            openPath: vi.fn(() => Promise.resolve('')),
        });

        await service.check();
        await expect(service.acknowledge()).resolves.toMatchObject({ announced: true });
        // Offering the download did not offer the restart.
        await expect(service.download()).resolves.toMatchObject({
            status: 'ready',
            announced: false,
        });
        await expect(service.acknowledge()).resolves.toMatchObject({
            status: 'ready',
            announced: true,
        });
        expect(service.getState()).toMatchObject({ status: 'ready', announced: true });
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

    it('keeps a visible download error through a background re-check', async () => {
        const dmg = new TextEncoder().encode('tampered dmg fixture');
        const fetch = releaseFetch('0.0.4', dmg, '0'.repeat(64));
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory: await temporaryDirectory(),
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
        });

        await service.check();
        await service.download();
        const callsBefore = fetch.mock.calls.length;

        await expect(service.check({ background: true })).resolves.toMatchObject({
            status: 'error',
            action: 'download',
        });
        expect(fetch).toHaveBeenCalledTimes(callsBefore);
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
        expect(result.reason).toBe('feed-unavailable');
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

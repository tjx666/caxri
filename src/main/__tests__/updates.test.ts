import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { compareStableVersions, UpdateService } from '../updates';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'caxri-updates-test-'));
    temporaryDirectories.push(path);
    return path;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
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

describe('stable version comparison', () => {
    it('orders Caxri release versions without a dependency on prerelease semantics', () => {
        expect(compareStableVersions('0.0.3', '0.0.4')).toBe(-1);
        expect(compareStableVersions('1.2.0', '1.1.9')).toBe(1);
        expect(compareStableVersions('v2.0.0', '2.0.0')).toBe(0);
        expect(() => compareStableVersions('2.0.0-beta.1', '2.0.0')).toThrow('unsupported version');
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

    it('coalesces concurrent checks into one GitHub request', async () => {
        const directory = await temporaryDirectory();
        const dmg = new TextEncoder().encode('dmg fixture');
        let resolveResponse!: (response: Response) => void;
        const fetch = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    resolveResponse = resolve;
                }),
        );
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

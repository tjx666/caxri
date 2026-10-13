import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { UpdateService } from '../updates';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { force: true, recursive: true })),
    );
});

function assetUrl(version: string, name: string): string {
    return `https://github.com/tjx666/caxri/releases/download/v${version}/${name}`;
}

describe('UpdateService Source Map flavor', () => {
    it('keeps an omit build on the explicit no-map update asset', async () => {
        const downloadDirectory = await mkdtemp(join(tmpdir(), 'caxri-update-flavor-test-'));
        temporaryDirectories.push(downloadDirectory);
        const dmg = new TextEncoder().encode('no-map dmg fixture');
        const checksum = createHash('sha256').update(dmg).digest('hex');
        const version = '0.0.4';
        const canonical = `Caxri-${version}-arm64.dmg`;
        const noMap = `Caxri-${version}-arm64-nosourcemap.dmg`;
        const fetch = vi.fn((input: string): Promise<Response> => {
            if (input.includes('/releases/latest')) {
                const names = [canonical, `${canonical}.sha256`, noMap, `${noMap}.sha256`];
                return Promise.resolve(
                    Response.json({
                        assets: names.map((name) => ({
                            browser_download_url: assetUrl(version, name),
                            name,
                            size: name.endsWith('.sha256') ? 96 : dmg.byteLength,
                        })),
                        draft: false,
                        prerelease: false,
                        tag_name: `v${version}`,
                    }),
                );
            }
            if (input.endsWith('.sha256'))
                return Promise.resolve(new Response(`${checksum}  ${noMap}\n`));
            if (input.endsWith('.dmg')) return Promise.resolve(new Response(dmg));
            return Promise.resolve(new Response(null, { status: 404 }));
        });
        const service = new UpdateService({
            currentVersion: '0.0.3',
            downloadDirectory,
            enabled: true,
            fetch,
            openPath: () => Promise.resolve(''),
            sourceMapFlavor: 'omit',
        });

        await expect(service.check()).resolves.toMatchObject({
            fileName: noMap,
            status: 'available',
        });
        await expect(service.download()).resolves.toMatchObject({
            fileName: noMap,
            status: 'ready',
        });
        expect(fetch.mock.calls.map(([url]) => url)).toEqual([
            'https://api.github.com/repos/tjx666/caxri/releases/latest',
            assetUrl(version, `${noMap}.sha256`),
            assetUrl(version, noMap),
        ]);
    });
});

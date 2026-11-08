import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { vi } from 'vitest';

import { LATEST_RELEASE_PAGE_URL } from '../../updates/update-github-release';

const temporaryDirectories: string[] = [];

/**
 * Creates a scratch directory that the registered `afterEach` removes.
 */
export async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'caxri-updates-test-'));
    temporaryDirectories.push(path);
    return path;
}

/**
 * Removes every directory created by `temporaryDirectory`; call it from `afterEach`.
 */
export async function removeTemporaryDirectories(): Promise<void> {
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((path) => rm(path, { recursive: true, force: true })),
    );
}

export function assetUrl(version: string, name: string): string {
    return `https://github.com/tjx666/caxri/releases/download/v${version}/${name}`;
}

function responseBody(bytes: Uint8Array): ArrayBuffer {
    return Uint8Array.from(bytes).buffer;
}

export function releaseResponse(version: string, dmg: Uint8Array, names?: string[]): Response {
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

/**
 * GitHub's answer for the release page fallback: a redirect to the latest stable tag.
 */
export function releasePageRedirect(version: string): Response {
    return new Response(null, {
        status: 302,
        headers: { location: `https://github.com/tjx666/caxri/releases/tag/v${version}` },
    });
}

/**
 * Serves `version` from both the releases API and the release page, plus its DMG and checksum.
 */
export function releaseFetch(
    version: string,
    dmg: Uint8Array,
    checksum = createHash('sha256').update(dmg).digest('hex'),
) {
    const fileName = `Caxri-${version}-arm64.dmg`;
    return vi.fn((input: string): Promise<Response> => {
        if (input === LATEST_RELEASE_PAGE_URL) return Promise.resolve(releasePageRedirect(version));
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

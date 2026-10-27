import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertReleaseApkFresh, MOBILE_APK_INPUTS, RELEASE_APK } from './promo-apk';

const repoRoot = resolve(import.meta.dirname, '../../../..');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { force: true, recursive: true })));
});

async function writeAt(root: string, path: string, seconds: number): Promise<void> {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '');
    await utimes(file, seconds, seconds);
}

describe('assertReleaseApkFresh', () => {
    it('watches only paths that exist, since a renamed input would silently stop counting', async () => {
        await Promise.all(MOBILE_APK_INPUTS.map((path) => access(join(repoRoot, path))));
    });

    it('rejects a missing APK and one older than a mobile source', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-promo-apk-'));
        temporaryDirectories.push(root);
        await writeAt(root, 'packages/protocol/src/index.ts', 2_000);
        await expect(assertReleaseApkFresh(root)).rejects.toThrow('--build-apk');

        await writeAt(root, RELEASE_APK, 1_000);
        await expect(assertReleaseApkFresh(root)).rejects.toThrow('older than the mobile sources');

        await writeAt(root, RELEASE_APK, 3_000);
        await expect(assertReleaseApkFresh(root)).resolves.toBeUndefined();
    });
});

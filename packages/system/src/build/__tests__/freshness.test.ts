import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertBuildOutputsFresh } from '../freshness';

const temporaryDirectories: string[] = [];
const watchedExtensions = new Set(['.ts', '.ttf']);
const staleMessage = 'stale build';

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'caxri-build-freshness-'));
    temporaryDirectories.push(root);
    const source = join(root, 'src');
    const output = join(root, 'out.js');
    const config = join(root, 'build.config.ts');
    await mkdir(source);
    await writeFile(output, 'output');
    await writeFile(config, 'config');
    return { config, output, root, source };
}

async function setMtime(path: string, seconds: number): Promise<void> {
    const timestamp = new Date(seconds * 1_000);
    await utimes(path, timestamp, timestamp);
}

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('assertBuildOutputsFresh', () => {
    it('treats explicit build configuration as an input', async () => {
        const paths = await fixture();
        await setMtime(paths.output, 10);
        await setMtime(paths.config, 20);

        await expect(
            assertBuildOutputsFresh({
                inputPaths: [paths.source, paths.config],
                outputPaths: [paths.output],
                watchedDirectoryExtensions: watchedExtensions,
                staleMessage,
            }),
        ).rejects.toThrow(staleMessage);
    });

    it('detects bundled font assets inside source directories', async () => {
        const paths = await fixture();
        const font = join(paths.source, 'terminal.ttf');
        await writeFile(font, 'font');
        await setMtime(paths.output, 10);
        await setMtime(paths.config, 5);
        await setMtime(font, 20);

        await expect(
            assertBuildOutputsFresh({
                inputPaths: [paths.source, paths.config],
                outputPaths: [paths.output],
                watchedDirectoryExtensions: watchedExtensions,
                staleMessage,
            }),
        ).rejects.toThrow(staleMessage);
    });
});

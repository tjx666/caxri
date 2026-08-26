import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { assertBuildOutputsFresh } from '../../src/shared/node/build-freshness';
import { createE2EBuildFreshnessOptions } from './build-freshness';

const temporaryDirectories: string[] = [];

async function setMtime(path: string, seconds: number): Promise<void> {
    const timestamp = new Date(seconds * 1_000);
    await utimes(path, timestamp, timestamp);
}

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

describe('E2E build freshness inputs', () => {
    it('declares the Extension Host bundle as a required output', () => {
        const root = '/project';

        expect(createE2EBuildFreshnessOptions(root).outputPaths).toEqual(
            expect.arrayContaining([
                join(root, 'extensions', 'git', 'dist', 'extension.js'),
                join(root, 'out', 'main', 'extension-host.js'),
                join(root, 'apps', 'cli', 'dist', 'caxri.cjs'),
            ]),
        );
    });

    it('declares every Desktop-consumed workspace source boundary', () => {
        const root = '/project';

        expect(createE2EBuildFreshnessOptions(root).inputPaths).toEqual(
            expect.arrayContaining([
                join(root, 'packages', 'agent-skills', 'package.json'),
                join(root, 'packages', 'agent-skills', 'scripts'),
                join(root, 'packages', 'agent-skills', 'src'),
                join(root, 'packages', 'client', 'src'),
                join(root, 'packages', 'extension-api', 'src'),
                join(root, 'apps', 'cli', 'src'),
                join(root, 'packages', 'utils', 'package.json'),
                join(root, 'packages', 'utils', 'src'),
                join(root, 'packages', 'utils', 'tsconfig.json'),
                join(root, 'skills', 'caxri-cli'),
            ]),
        );
    });

    it('accepts a fresh build and rejects it after a utils source change', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-e2e-build-freshness-'));
        temporaryDirectories.push(root);
        const options = createE2EBuildFreshnessOptions(root);
        const utilitiesRoot = join(root, 'packages', 'utils');
        const source = join(utilitiesRoot, 'src', 'index.ts');
        const output = join(root, 'out', 'renderer', 'index.html');
        const inputPaths = options.inputPaths.filter((path) => path.startsWith(utilitiesRoot));

        await Promise.all(
            [
                source,
                join(utilitiesRoot, 'package.json'),
                join(utilitiesRoot, 'tsconfig.json'),
                output,
            ].map(async (path) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, 'fixture');
            }),
        );
        await Promise.all(inputPaths.map((path) => setMtime(path, 10)));
        await setMtime(source, 10);
        await setMtime(output, 20);

        const focusedOptions = { ...options, inputPaths, outputPaths: [output] };
        await expect(assertBuildOutputsFresh(focusedOptions)).resolves.toBeUndefined();

        await setMtime(source, 30);
        await expect(assertBuildOutputsFresh(focusedOptions)).rejects.toThrow(options.staleMessage);
    });

    it('accepts fresh fixture media and rejects it after the media changes', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-e2e-build-freshness-'));
        temporaryDirectories.push(root);
        const options = createE2EBuildFreshnessOptions(root);
        const mediaRoot = join(root, 'extensions', 'fixture', 'media');
        const mediaFile = join(mediaRoot, 'fixture.svg');
        const output = join(root, 'out', 'renderer', 'index.html');
        const inputPaths = options.inputPaths.filter((path) => path === mediaRoot);

        expect(inputPaths).toEqual([mediaRoot]);
        await Promise.all(
            [mediaFile, output].map(async (path) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, 'fixture');
            }),
        );
        await setMtime(mediaFile, 10);
        await setMtime(output, 20);

        const focusedOptions = { ...options, inputPaths, outputPaths: [output] };
        await expect(assertBuildOutputsFresh(focusedOptions)).resolves.toBeUndefined();

        await setMtime(mediaFile, 30);
        await expect(assertBuildOutputsFresh(focusedOptions)).rejects.toThrow(options.staleMessage);
    });
});

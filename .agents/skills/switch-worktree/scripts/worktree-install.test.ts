import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { runCapture } from './process';
import { createWorktree, installWorktreeDependencies } from './worktree';

const temporaryDirectories: string[] = [];

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    return runCapture('git', arguments_, cwd);
}

async function createRepoFixture(): Promise<{ root: string; temporary: string }> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-worktree-install-retry-'));
    temporaryDirectories.push(temporary);
    const remote = join(temporary, 'remote.git');
    const root = join(temporary, 'caxri');
    await mkdir(root);
    await git(temporary, 'init', '--bare', '-b', 'main', remote);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'caxri@example.invalid');
    await git(root, 'config', 'user.name', 'Caxri Test');
    await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
    await git(root, 'add', 'README.md');
    await git(root, 'commit', '-m', 'initial');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-u', 'origin', 'main');
    return { root, temporary };
}

async function createCompleteElectronArtifacts(path: string): Promise<void> {
    const electronDirectory = join(path, 'node_modules', 'electron');
    await mkdir(join(electronDirectory, 'dist'), { recursive: true });
    await writeFile(join(electronDirectory, 'package.json'), '{"version":"1.0.0"}\n', 'utf8');
    await writeFile(join(electronDirectory, 'path.txt'), 'electron', 'utf8');
    await writeFile(join(electronDirectory, 'dist', 'version'), 'v1.0.0\n', 'utf8');
    await writeFile(join(electronDirectory, 'dist', 'electron'), 'binary', 'utf8');
}

afterEach(async () => {
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('worktree dependency installation', () => {
    it('repairs missing Electron postinstall artifacts exactly once', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-worktree-electron-install-'));
        temporaryDirectories.push(temporary);
        const binaryDirectory = join(temporary, 'bin');
        const electronDirectory = join(temporary, 'node_modules', 'electron');
        const postinstallMarker = join(temporary, 'electron-postinstall-runs');
        await mkdir(binaryDirectory);
        await mkdir(electronDirectory, { recursive: true });
        const niPath = join(binaryDirectory, 'ni');
        await writeFile(niPath, '#!/bin/sh\nexit 0\n', 'utf8');
        await chmod(niPath, 0o755);
        await writeFile(
            join(electronDirectory, 'install.js'),
            [
                "const { appendFileSync, mkdirSync, writeFileSync } = require('node:fs');",
                "const { join } = require('node:path');",
                "const executable = 'Electron.app/Contents/MacOS/Electron';",
                "mkdirSync(join(__dirname, 'dist', executable, '..'), { recursive: true });",
                'writeFileSync(join(__dirname, \'package.json\'), \'{"version":"1.0.0"}\');',
                String.raw`writeFileSync(join(__dirname, 'dist', 'version'), 'v1.0.0\n');`,
                "writeFileSync(join(__dirname, 'dist', executable), 'binary');",
                "writeFileSync(join(__dirname, 'path.txt'), executable);",
                String.raw`appendFileSync(process.env.CAXRI_TEST_ELECTRON_POSTINSTALL_MARKER, 'run\n');`,
            ].join('\n'),
            'utf8',
        );
        const previousPath = process.env.PATH;
        const previousMarker = process.env.CAXRI_TEST_ELECTRON_POSTINSTALL_MARKER;
        try {
            process.env.PATH = `${binaryDirectory}:${previousPath}`;
            process.env.CAXRI_TEST_ELECTRON_POSTINSTALL_MARKER = postinstallMarker;
            await installWorktreeDependencies(temporary);
            expect(await readFile(join(electronDirectory, 'path.txt'), 'utf8')).toBe(
                'Electron.app/Contents/MacOS/Electron',
            );
            expect(
                await readFile(
                    join(electronDirectory, 'dist', 'Electron.app/Contents/MacOS/Electron'),
                    'utf8',
                ),
            ).toBe('binary');

            await installWorktreeDependencies(temporary);
        } finally {
            process.env.PATH = previousPath;
            if (previousMarker === undefined)
                delete process.env.CAXRI_TEST_ELECTRON_POSTINSTALL_MARKER;
            else process.env.CAXRI_TEST_ELECTRON_POSTINSTALL_MARKER = previousMarker;
        }

        expect(await readFile(postinstallMarker, 'utf8')).toBe('run\n');
    });

    it('retries an existing worktree left incomplete by a failed postinstall', async () => {
        const fixture = await createRepoFixture();
        const failAfterDependencies = async (path: string): Promise<void> => {
            await mkdir(join(path, 'node_modules'));
            throw new Error('temporary Electron postinstall failure');
        };
        await expect(
            createWorktree({
                branch: 'fix/retry-create-postinstall',
                cwd: fixture.root,
                install: failAfterDependencies,
            }),
        ).rejects.toThrow('temporary Electron postinstall failure');

        const repaired = await createWorktree({
            branch: 'fix/retry-create-postinstall',
            cwd: fixture.root,
            install: createCompleteElectronArtifacts,
        });
        expect(repaired.dependencies).toBe('ready');
        expect(
            await readFile(
                join(repaired.path, 'node_modules', 'electron', 'dist', 'electron'),
                'utf8',
            ),
        ).toBe('binary');
    });
});

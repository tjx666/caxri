import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { runCapture } from './process';
import { repoContext, withRepoLock } from './repo';
import { createWorktree } from './worktree';
import { installWorktreeDependencies } from './worktree-install';

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
    it('prepares the node-pty helper after installing dependencies', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-worktree-node-pty-'));
        temporaryDirectories.push(temporary);
        const binaryDirectory = join(temporary, 'bin');
        const marker = join(temporary, 'node-pty-prepare-runs');
        await Promise.all([
            mkdir(binaryDirectory),
            mkdir(join(temporary, 'scripts'), { recursive: true }),
            createCompleteElectronArtifacts(temporary),
        ]);
        const niPath = join(binaryDirectory, 'ni');
        const bunPath = join(binaryDirectory, 'bun');
        await Promise.all([
            writeFile(niPath, '#!/bin/sh\nexit 0\n', 'utf8'),
            writeFile(
                bunPath,
                '#!/bin/sh\nprintf "%s\\n" "$*" > "$CAXRI_TEST_NODE_PTY_MARKER"\n',
                'utf8',
            ),
            writeFile(join(temporary, 'scripts', 'prepare-node-pty.ts'), '// fixture\n', 'utf8'),
        ]);
        await Promise.all([chmod(niPath, 0o755), chmod(bunPath, 0o755)]);

        const previousPath = process.env.PATH;
        const previousMarker = process.env.CAXRI_TEST_NODE_PTY_MARKER;
        try {
            process.env.PATH = `${binaryDirectory}:${previousPath}`;
            process.env.CAXRI_TEST_NODE_PTY_MARKER = marker;
            await installWorktreeDependencies(temporary);
        } finally {
            process.env.PATH = previousPath;
            if (previousMarker === undefined) delete process.env.CAXRI_TEST_NODE_PTY_MARKER;
            else process.env.CAXRI_TEST_NODE_PTY_MARKER = previousMarker;
        }

        expect(await readFile(marker, 'utf8')).toBe('run scripts/prepare-node-pty.ts\n');
    });

    it('repairs missing Electron binary artifacts exactly once', async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-worktree-electron-install-'));
        temporaryDirectories.push(temporary);
        const binaryDirectory = join(temporary, 'bin');
        const electronDirectory = join(temporary, 'node_modules', 'electron');
        const installMarker = join(temporary, 'electron-install-runs');
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
                String.raw`appendFileSync(process.env.CAXRI_TEST_ELECTRON_INSTALL_MARKER, 'run\n');`,
            ].join('\n'),
            'utf8',
        );
        const previousPath = process.env.PATH;
        const previousMarker = process.env.CAXRI_TEST_ELECTRON_INSTALL_MARKER;
        try {
            process.env.PATH = `${binaryDirectory}:${previousPath}`;
            process.env.CAXRI_TEST_ELECTRON_INSTALL_MARKER = installMarker;
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
            if (previousMarker === undefined) delete process.env.CAXRI_TEST_ELECTRON_INSTALL_MARKER;
            else process.env.CAXRI_TEST_ELECTRON_INSTALL_MARKER = previousMarker;
        }

        expect(await readFile(installMarker, 'utf8')).toBe('run\n');
    });

    it('retries an existing worktree left incomplete by a failed Electron install', async () => {
        const fixture = await createRepoFixture();
        const failAfterDependencies = async (path: string): Promise<void> => {
            await mkdir(join(path, 'node_modules'));
            throw new Error('temporary Electron install failure');
        };
        await expect(
            createWorktree({
                branch: 'fix/retry-create-postinstall',
                cwd: fixture.root,
                install: failAfterDependencies,
            }),
        ).rejects.toThrow('temporary Electron install failure');

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
    /**
     * `ni` runs for tens of seconds while every other switch-worktree operation waits at most 10 seconds for the
     * repository lock: a sibling session releasing its desktop lease after an E2E run failed while a create installed.
     */
    it('installs dependencies without holding the repository lock', async () => {
        const fixture = await createRepoFixture();
        const installing = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let installCount = 0;
        const slowInstall = async (path: string): Promise<void> => {
            installCount += 1;
            installing.resolve();
            await release.promise;
            await mkdir(join(path, 'node_modules'));
            await createCompleteElectronArtifacts(path);
        };
        const creating = createWorktree({
            branch: 'chore/slow-install',
            cwd: fixture.root,
            install: slowInstall,
        });
        await installing.promise;
        await expect(
            withRepoLock(await repoContext(fixture.root), () => Promise.resolve('acquired')),
        ).resolves.toBe('acquired');

        const resolvingSameBranch = createWorktree({
            branch: 'chore/slow-install',
            cwd: fixture.root,
            install: slowInstall,
        });
        release.resolve();
        const [created, resolved] = await Promise.all([creating, resolvingSameBranch]);
        expect(created.dependencies).toBe('ready');
        expect(resolved.path).toBe(created.path);
        expect(installCount).toBe(1);
    });
});

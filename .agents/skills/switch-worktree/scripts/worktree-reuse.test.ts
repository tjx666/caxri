import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCapture } from './process';
import { createWorktree } from './worktree';
import { reuseWorktree } from './worktree-reuse';

const temporaryDirectories: string[] = [];

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    return (await runCapture('git', arguments_, cwd)).trim();
}

async function createFixture(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-worktree-reuse-'));
    temporaryDirectories.push(temporary);
    const remote = join(temporary, 'remote.git');
    const root = join(temporary, 'caxri');
    await mkdir(root);
    await git(temporary, 'init', '--bare', '-b', 'main', remote);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'caxri@example.invalid');
    await git(root, 'config', 'user.name', 'Caxri Test');
    await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
    await writeFile(join(root, '.gitignore'), 'node_modules/\n', 'utf8');
    await git(root, 'add', 'README.md', '.gitignore');
    await git(root, 'commit', '-m', 'initial');
    await git(root, 'remote', 'add', 'origin', remote);
    await git(root, 'push', '-u', 'origin', 'main');
    await mkdir(join(root, 'node_modules'));
    return root;
}

async function fakeInstall(path: string): Promise<void> {
    const electronDirectory = join(path, 'node_modules', 'electron');
    await mkdir(join(electronDirectory, 'dist'), { recursive: true });
    await writeFile(join(electronDirectory, 'package.json'), '{"version":"1.0.0"}\n', 'utf8');
    await writeFile(join(electronDirectory, 'path.txt'), 'electron', 'utf8');
    await writeFile(join(electronDirectory, 'dist', 'version'), 'v1.0.0\n', 'utf8');
    await writeFile(join(electronDirectory, 'dist', 'electron'), 'binary', 'utf8');
}

/**
 * A worktree whose single delivery commit was squash-merged into `origin/main`, which then advanced once more.
 */
async function createMergedWorktree(root: string, branch: string): Promise<string> {
    const { path } = await createWorktree({ branch, cwd: root, install: fakeInstall });
    await writeFile(join(path, 'feature.txt'), 'feature\n', 'utf8');
    await git(path, 'add', 'feature.txt');
    await git(path, 'commit', '-m', 'feature');
    await git(root, 'merge', '--squash', branch);
    await git(root, 'commit', '-m', 'squash merged');
    await writeFile(join(root, 'later.txt'), 'later\n', 'utf8');
    await git(root, 'add', 'later.txt');
    await git(root, 'commit', '-m', 'later');
    await git(root, 'push', 'origin', 'main');
    return path;
}

afterEach(async () => {
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('switch-worktree reuse', () => {
    it('starts a new branch from the latest origin/main in a clean, merged worktree', async () => {
        const root = await createFixture();
        const path = await createMergedWorktree(root, 'feat/first-delivery');

        const result = await reuseWorktree({
            branch: 'fix/second-delivery',
            cwd: root,
            install: fakeInstall,
            target: path,
        });

        expect(result.path).toBe(path);
        expect(await git(path, 'branch', '--show-current')).toBe('fix/second-delivery');
        expect(await git(path, 'rev-parse', 'HEAD')).toBe(await git(root, 'rev-parse', 'main'));
    });

    it('refuses a dirty worktree and leaves its branch and files untouched', async () => {
        const root = await createFixture();
        const path = await createMergedWorktree(root, 'feat/first-delivery');
        await writeFile(join(path, 'README.md'), '# sibling edit\n', 'utf8');

        await expect(
            reuseWorktree({ branch: 'fix/second', cwd: root, install: fakeInstall, target: path }),
        ).rejects.toThrow('Refusing to reuse dirty worktree');
        expect(await git(path, 'branch', '--show-current')).toBe('feat/first-delivery');
        expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('# sibling edit\n');
        await expect(git(root, 'rev-parse', '--verify', 'refs/heads/fix/second')).rejects.toThrow();
    });

    it('refuses a branch that was pushed but never merged into origin/main', async () => {
        const root = await createFixture();
        const { path } = await createWorktree({
            branch: 'feat/open-delivery',
            cwd: root,
            install: fakeInstall,
        });
        await writeFile(join(path, 'pending.txt'), 'pending\n', 'utf8');
        await git(path, 'add', 'pending.txt');
        await git(path, 'commit', '-m', 'pending');
        await git(path, 'push', 'origin', 'HEAD:refs/heads/feat/open-delivery');

        await expect(
            reuseWorktree({ branch: 'fix/second', cwd: root, install: fakeInstall, target: path }),
        ).rejects.toThrow('is not merged into origin/main');
        expect(await git(path, 'branch', '--show-current')).toBe('feat/open-delivery');
    });

    it('refuses the primary checkout and a new branch name that already exists', async () => {
        const root = await createFixture();
        const path = await createMergedWorktree(root, 'feat/first-delivery');
        await git(root, 'branch', 'fix/taken');

        await expect(
            reuseWorktree({
                branch: 'fix/second',
                cwd: root,
                install: fakeInstall,
                target: 'main',
            }),
        ).rejects.toThrow('primary worktree');
        await expect(
            reuseWorktree({ branch: 'fix/taken', cwd: root, install: fakeInstall, target: path }),
        ).rejects.toThrow('already exists locally');
        expect(await git(path, 'branch', '--show-current')).toBe('feat/first-delivery');
    });
});

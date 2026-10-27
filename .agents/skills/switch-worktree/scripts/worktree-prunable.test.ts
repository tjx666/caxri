import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCapture } from './process';
import { createWorktree, listWorktreeStatus } from './worktree';

const temporaryDirectories: string[] = [];

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    return runCapture('git', arguments_, cwd);
}

async function createFixture(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-prunable-worktree-'));
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

afterEach(async () => {
    const directoriesToRemove = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        directoriesToRemove.map((directory) => rm(directory, { recursive: true, force: true })),
    );
});

describe('switch-worktree list with a prunable registration', () => {
    it('lists the remaining worktrees when a registered one lost its directory', async () => {
        const root = await createFixture();
        const kept = await createWorktree({ branch: 'docs/kept', cwd: root, install: fakeInstall });
        const gone = await createWorktree({ branch: 'docs/gone', cwd: root, install: fakeInstall });
        await rm(gone.path, { recursive: true, force: true });

        const statuses = await listWorktreeStatus(root);
        expect(statuses.find((status) => status.branch === 'docs/kept')).toMatchObject({
            path: kept.path,
            dependencies: 'ready',
            managed: true,
        });
        // Git's own reason, so the reader knows `git worktree prune` is the fix.
        const stale = statuses.find((status) => status.branch === 'docs/gone');
        expect(stale?.prunable).toContain('non-existent');
        expect(stale).toMatchObject({
            path: gone.path,
            ahead: null,
            behind: null,
            devProcess: 'none',
            dirty: false,
            orphanProcesses: [],
        });
    });
});

import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCapture } from './process';
import { createWorktree, removeWorktree } from './worktree';

const temporaryDirectories: string[] = [];

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    return runCapture('git', arguments_, cwd);
}

async function createFixture(): Promise<{ root: string; temporary: string }> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-squash-removal-'));
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
    return { root, temporary };
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

describe('switch-worktree squash removal', () => {
    async function createSquashMergedWorktree(root: string, branch: string) {
        const created = await createWorktree({ branch, cwd: root, install: fakeInstall });
        await writeFile(join(created.path, 'first.txt'), 'first\n', 'utf8');
        await git(created.path, 'add', 'first.txt');
        await git(created.path, 'commit', '-m', 'first squash candidate');
        await writeFile(join(created.path, 'second.txt'), 'second\n', 'utf8');
        await git(created.path, 'add', 'second.txt');
        await git(created.path, 'commit', '-m', 'second squash candidate');
        await git(created.path, 'push', 'origin', `HEAD:refs/heads/${branch}`);

        await git(root, 'merge', '--squash', branch);
        await git(root, 'commit', '-m', 'squash merged');
        const squashCommit = (await git(root, 'rev-parse', 'HEAD')).trim();
        await git(root, 'push', 'origin', 'main');
        await git(created.path, 'push', 'origin', '--delete', branch);
        return { created, squashCommit };
    }

    it('accepts a multi-commit squash merge after main advances', async () => {
        const fixture = await createFixture();
        const { created } = await createSquashMergedWorktree(
            fixture.root,
            'chore/squash-merged-removal',
        );
        expect((await git(created.path, 'rev-parse', '--abbrev-ref', '@{upstream}')).trim()).toBe(
            'origin/main',
        );
        await writeFile(join(fixture.root, 'later-main.txt'), 'later\n', 'utf8');
        await git(fixture.root, 'add', 'later-main.txt');
        await git(fixture.root, 'commit', '-m', 'later main change');
        await git(fixture.root, 'push', 'origin', 'main');

        await expect(
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).resolves.toMatchObject({ path: created.path, profileKept: false });
        await expect(lstat(created.path)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('accepts a squash merge without an upstream', async () => {
        const fixture = await createFixture();
        const { created } = await createSquashMergedWorktree(
            fixture.root,
            'chore/squash-merged-no-upstream',
        );
        await git(created.path, 'branch', '--unset-upstream');

        await expect(
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).resolves.toMatchObject({ path: created.path, profileKept: false });
    });

    it('rejects a unique commit after its remote branch is deleted', async () => {
        const fixture = await createFixture();
        const branch = 'chore/deleted-unmerged-branch';
        const created = await createWorktree({
            branch,
            cwd: fixture.root,
            install: fakeInstall,
        });
        await writeFile(join(created.path, 'unique.txt'), 'unique\n', 'utf8');
        await git(created.path, 'add', 'unique.txt');
        await git(created.path, 'commit', '-m', 'unique change');
        await git(created.path, 'push', 'origin', `HEAD:refs/heads/${branch}`);
        await git(created.path, 'push', 'origin', '--delete', branch);

        await expect(
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).rejects.toThrow('changes are not preserved on origin');
    });

    it('rejects a unique commit retained only on another remote', async () => {
        const fixture = await createFixture();
        const created = await createWorktree({
            branch: 'chore/fork-only-branch',
            cwd: fixture.root,
            install: fakeInstall,
        });
        await writeFile(join(created.path, 'fork-only.txt'), 'fork\n', 'utf8');
        await git(created.path, 'add', 'fork-only.txt');
        await git(created.path, 'commit', '-m', 'fork-only change');
        const fork = join(fixture.temporary, 'fork.git');
        await git(fixture.temporary, 'init', '--bare', '-b', 'main', fork);
        await git(created.path, 'remote', 'add', 'fork', fork);
        await git(created.path, 'push', 'fork', 'HEAD:refs/heads/chore/fork-only-branch');

        await expect(
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).rejects.toThrow('changes are not preserved on origin');
    });

    it('rejects a squash merge that was reverted on main', async () => {
        const fixture = await createFixture();
        const { created, squashCommit } = await createSquashMergedWorktree(
            fixture.root,
            'chore/reverted-squash-merge',
        );
        await git(fixture.root, 'revert', '--no-edit', squashCommit);
        await git(fixture.root, 'push', 'origin', 'main');

        await expect(
            removeWorktree({ cwd: fixture.root, preserveProfile: false, target: created.path }),
        ).rejects.toThrow('changes are not preserved on origin');
    });
});

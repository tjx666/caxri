import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCapture } from './process';
import { assertBranchContainsBase, assertRemoteBranchAbsent } from './worktree-branch';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const paths = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { force: true, recursive: true })));
});

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    return runCapture('git', arguments_, cwd);
}

async function createRepoWithStaleBranch(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-worktree-branch-'));
    temporaryDirectories.push(root);
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'caxri@example.invalid');
    await git(root, 'config', 'user.name', 'Caxri Test');
    await writeFile(join(root, 'README.md'), '# fixture\n', 'utf8');
    await git(root, 'add', 'README.md');
    await git(root, 'commit', '-m', 'initial');
    await git(root, 'branch', 'fix/stale-name');
    await writeFile(join(root, 'newer.txt'), 'newer\n', 'utf8');
    await git(root, 'add', 'newer.txt');
    await git(root, 'commit', '-m', 'newer base');
    return root;
}

describe('assertBranchContainsBase', () => {
    it('refuses an existing branch that does not contain the explicit base', async () => {
        const root = await createRepoWithStaleBranch();
        await expect(assertBranchContainsBase(root, 'fix/stale-name', 'main')).rejects.toThrow(
            'already exists and does not contain main',
        );
    });

    it('allows a new branch, a branch that contains the base, or no explicit base', async () => {
        const root = await createRepoWithStaleBranch();
        await expect(
            assertBranchContainsBase(root, 'fix/new-name', 'main'),
        ).resolves.toBeUndefined();
        await expect(
            assertBranchContainsBase(root, 'fix/stale-name', 'main~1'),
        ).resolves.toBeUndefined();
        await expect(
            assertBranchContainsBase(root, 'fix/stale-name', undefined),
        ).resolves.toBeUndefined();
    });
});

describe('assertRemoteBranchAbsent', () => {
    it('refuses a name that already exists on origin, even when origin only tracks main', async () => {
        const root = await createRepoWithStaleBranch();
        const remote = await mkdtemp(join(tmpdir(), 'caxri-worktree-remote-'));
        temporaryDirectories.push(remote);
        await git(remote, 'init', '--bare', '-b', 'main');
        await git(root, 'remote', 'add', 'origin', remote);
        await git(root, 'push', 'origin', 'main', 'fix/stale-name');
        await git(root, 'branch', '-D', 'fix/stale-name');

        await expect(assertRemoteBranchAbsent(root, 'fix/stale-name')).rejects.toThrow(
            'already exists on origin',
        );
        await expect(assertRemoteBranchAbsent(root, 'fix/new-name')).resolves.toBeUndefined();
    });

    it('reports an unreachable origin instead of treating the name as free', async () => {
        const root = await createRepoWithStaleBranch();
        await git(root, 'remote', 'add', 'origin', join(root, 'missing.git'));
        await expect(assertRemoteBranchAbsent(root, 'fix/new-name')).rejects.toThrow(
            'Could not check whether fix/new-name already exists on origin',
        );
    });
});

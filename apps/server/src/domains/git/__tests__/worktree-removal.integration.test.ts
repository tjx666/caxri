import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { execFileAsync } from '@caxri/system';
import { describe, expect, it, onTestFinished } from 'vitest';

import { removeLinkedWorktree } from '../worktree-removal';

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', arguments_, { cwd });
    return stdout;
}

async function isPresent(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function repo(options: { detached?: boolean } = {}) {
    const created = await mkdtemp(join(tmpdir(), 'caxri-worktree-removal-'));
    const directory = await realpath(created);
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const ownerRoot = join(directory, 'owner');
    const rootPath = join(directory, 'linked');
    await mkdir(ownerRoot);
    await git(ownerRoot, 'init', '-b', 'main');
    await git(ownerRoot, 'config', 'user.email', 'caxri@example.invalid');
    await git(ownerRoot, 'config', 'user.name', 'Caxri Test');
    await writeFile(join(ownerRoot, '.gitignore'), 'node_modules/\n');
    await git(ownerRoot, 'add', '.gitignore');
    await git(ownerRoot, 'commit', '-m', 'init');
    await (options.detached
        ? git(ownerRoot, 'worktree', 'add', '--detach', rootPath)
        : git(ownerRoot, 'worktree', 'add', '-b', 'feat/x', rootPath));
    await mkdir(join(rootPath, 'node_modules'));
    await writeFile(join(rootPath, 'node_modules', 'dependency.js'), '');
    return { ownerRoot, rootPath };
}

/**
 * Mirrors `runGitCommand`'s `allowFailure`, which answers a failed command with empty output.
 */
async function runner(
    cwd: string,
    arguments_: string[],
    options?: { allowFailure?: boolean },
): Promise<string> {
    try {
        return await git(cwd, ...arguments_);
    } catch (error) {
        if (options?.allowFailure) return '';
        throw error;
    }
}

describe('removeLinkedWorktree', () => {
    it('deletes a clean worktree with its ignored files and keeps the branch', async () => {
        const { ownerRoot, rootPath } = await repo();
        await expect(
            removeLinkedWorktree(runner, { backupMessage: 'backup', ownerRoot, rootPath }),
        ).resolves.toEqual({ outcome: 'removed', isBackupCommitted: false });
        expect(await isPresent(rootPath)).toBe(false);
        expect(await git(ownerRoot, 'worktree', 'list', '--porcelain')).not.toContain(rootPath);
        expect((await git(ownerRoot, 'branch', '--list', 'feat/x')).trim()).toBe('feat/x');
    });

    it('commits uncommitted changes to the branch before deleting the worktree', async () => {
        const { ownerRoot, rootPath } = await repo();
        await writeFile(join(rootPath, 'draft.md'), 'unfinished');
        await writeFile(join(rootPath, '.gitignore'), 'node_modules/\ndist/\n');
        await expect(
            removeLinkedWorktree(runner, { backupMessage: 'backup', ownerRoot, rootPath }),
        ).resolves.toEqual({ outcome: 'removed', isBackupCommitted: true });
        expect(await isPresent(rootPath)).toBe(false);
        expect((await git(ownerRoot, 'log', '-1', '--format=%s', 'feat/x')).trim()).toBe('backup');
        expect(await git(ownerRoot, 'show', 'feat/x:draft.md')).toBe('unfinished');
        expect(await git(ownerRoot, 'ls-tree', '--name-only', 'feat/x')).not.toContain(
            'node_modules',
        );
    });

    it('keeps a detached worktree even when clean, since its commits may be on no branch', async () => {
        const { ownerRoot, rootPath } = await repo({ detached: true });
        await git(rootPath, 'commit', '--allow-empty', '-m', 'only here');
        await expect(
            removeLinkedWorktree(runner, { backupMessage: 'backup', ownerRoot, rootPath }),
        ).resolves.toEqual({ outcome: 'refused', reason: 'detached' });
        expect(await isPresent(join(rootPath, '.gitignore'))).toBe(true);
    });

    it('keeps a worktree with a merge in progress instead of committing its conflict state', async () => {
        const { ownerRoot, rootPath } = await repo();
        // Git refuses `update-ref` for pseudo-refs, so write MERGE_HEAD the way `git merge` leaves it.
        const mergeHead = (await git(rootPath, 'rev-parse', '--git-path', 'MERGE_HEAD')).trim();
        await writeFile(resolve(rootPath, mergeHead), await git(rootPath, 'rev-parse', 'HEAD'));
        await writeFile(join(rootPath, 'draft.md'), 'unfinished');
        await expect(
            removeLinkedWorktree(runner, { backupMessage: 'backup', ownerRoot, rootPath }),
        ).resolves.toEqual({ outcome: 'refused', reason: 'operation-in-progress' });
        expect(await isPresent(join(rootPath, 'draft.md'))).toBe(true);
    });
});

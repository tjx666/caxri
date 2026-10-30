import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { execFileAsync } from '@caxri/system';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createLinkedWorktree, linkedWorktreePath } from '../worktree-creation';

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', arguments_, { cwd });
    return stdout;
}

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

async function repo() {
    const created = await mkdtemp(join(tmpdir(), 'caxri-worktree-creation-'));
    const directory = await realpath(created);
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const ownerRoot = join(directory, 'owner');
    await mkdir(ownerRoot);
    await git(ownerRoot, 'init', '-b', 'main');
    await git(ownerRoot, 'config', 'user.email', 'caxri@example.invalid');
    await git(ownerRoot, 'config', 'user.name', 'Caxri Test');
    await writeFile(join(ownerRoot, 'a.txt'), 'a');
    await git(ownerRoot, 'add', 'a.txt');
    await git(ownerRoot, 'commit', '-m', 'init');
    return { directory, ownerRoot };
}

describe('createLinkedWorktree', () => {
    it('creates a worktree beside the Project on a new branch', async () => {
        const { directory, ownerRoot } = await repo();
        const rootPath = await createLinkedWorktree(runner, { ownerRoot, branch: 'feat/x' });
        expect(rootPath).toBe(join(directory, 'owner.worktrees', 'feat-x'));
        expect(rootPath).toBe(linkedWorktreePath(ownerRoot, 'feat/x'));
        await expect(access(join(rootPath, 'a.txt'))).resolves.toBeUndefined();
        expect((await git(rootPath, 'branch', '--show-current')).trim()).toBe('feat/x');
    });

    it('refuses an invalid or existing branch without creating anything', async () => {
        const { directory, ownerRoot } = await repo();
        await Promise.all(
            ['--detach', 'a..b', 'bad name', '@{-1}'].map((branch) =>
                expect(createLinkedWorktree(runner, { ownerRoot, branch })).rejects.toThrow(),
            ),
        );
        await git(ownerRoot, 'branch', 'taken');
        await expect(
            createLinkedWorktree(runner, { ownerRoot, branch: 'taken' }),
        ).rejects.toThrow();
        await expect(access(join(directory, 'owner.worktrees', 'taken'))).rejects.toThrow();
    });
});

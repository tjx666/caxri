import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { addPlannedWorktree } from './planned-worktree';
import { runCapture } from './process';
import { createWorktree, switchWorktree } from './worktree';
import { planWorktree } from './worktree-plan';

const temporaryDirectories: string[] = [];

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    return runCapture('git', arguments_, cwd);
}

async function createFixture(): Promise<string> {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-plan-worktree-'));
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

/**
 * Caxri follows a new worktree only when the Agent's own shell command is the literal `git worktree add`, so the script
 * must print that command rather than run it.
 */
describe('switch-worktree plan', () => {
    it('prints the add for a new branch without creating the checkout', async () => {
        const root = await createFixture();
        const plan = await planWorktree({ branch: 'feat/planned', cwd: root });

        expect(plan.command).toEqual([
            'git',
            'worktree',
            'add',
            '-b',
            'feat/planned',
            plan.path,
            'origin/main',
        ]);
        expect(await git(root, 'branch', '--list', 'feat/planned')).toBe('');
        await expect(
            createWorktree({ branch: 'feat/planned', cwd: root, install: fakeInstall }),
        ).rejects.toThrow('Run `plan feat/planned`');
    });

    it('routes an unmaterialized local branch through plan instead of adding it in switch', async () => {
        const root = await createFixture();
        await git(root, 'branch', 'feat/dormant', 'origin/main');

        await expect(switchWorktree(root, 'feat/dormant', fakeInstall)).rejects.toThrow(
            'Run `plan feat/dormant`',
        );
        const plan = await planWorktree({ branch: 'feat/dormant', cwd: root });
        expect(plan.command).toEqual(['git', 'worktree', 'add', plan.path, 'feat/dormant']);
        const created = await addPlannedWorktree({
            branch: 'feat/dormant',
            cwd: root,
            install: fakeInstall,
        });
        expect(created.managed).toBe(true);
        expect(created.dependencies).toBe('ready');
        expect((await planWorktree({ branch: 'feat/dormant', cwd: root })).command).toBeNull();
    });

    it('refuses to adopt a checkout outside the managed directory', async () => {
        const root = await createFixture();
        await git(root, 'worktree', 'add', '-b', 'feat/elsewhere', join(root, '..', 'elsewhere'));

        await expect(
            createWorktree({ branch: 'feat/elsewhere', cwd: root, install: fakeInstall }),
        ).rejects.toThrow('outside the managed worktree directory');
    });

    it('plans existing branches under portable worktree directory names', async () => {
        const root = await createFixture();
        // Each iteration mutates the shared fixture repository, so the branches must be created and planned sequentially rather than concurrently.
        /* eslint-disable no-await-in-loop -- sequential mutation of one shared git repository */
        for (const branch of ['feat/foo%2Fbar', 'feat/windows<bad>|"name"']) {
            await git(root, 'branch', branch, 'origin/main');
            const { path } = await planWorktree({ branch, cwd: root });
            expect(basename(path)).toMatch(/^[\w.-]+$/);
            expect(basename(path).toLowerCase()).not.toContain('%2f');
        }
        /* eslint-enable no-await-in-loop */
    });
});

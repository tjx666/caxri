import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { assertExplicitFiles } from '../explicit-files';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '../../../../..');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { force: true, recursive: true })));
});

/**
 * A repository on a `feature` branch off `origin/main`, holding every kind of path an explicit argument can name.
 */
async function fixtureRepo({ hasOriginMain = true } = {}): Promise<{
    check: (...arguments_: string[]) => Promise<void>;
}> {
    const root = await mkdtemp(join(tmpdir(), 'caxri-check-explicit-'));
    temporaryDirectories.push(root);
    const git = (...arguments_: string[]): string =>
        execFileSync('git', arguments_, { cwd: root, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Check Test');
    git('config', 'user.email', 'check@example.invalid');
    for (const name of [
        'kept.ts',
        'committed-delete.ts',
        'renamed.ts',
        'staged-delete.ts',
        'unstaged-delete.ts',
        'deleted space.ts',
    ])
        // eslint-disable-next-line no-await-in-loop -- a handful of fixture files
        await writeFile(join(root, name), 'export {};\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    git('switch', '-q', '-c', 'feature');
    await writeFile(join(root, 'branch-only.ts'), 'export {};\n');
    git('add', 'branch-only.ts');
    git('rm', '-q', 'committed-delete.ts');
    git('mv', 'renamed.ts', 'moved.ts');
    git('commit', '-q', '-m', 'feature');
    git('rm', '-q', 'staged-delete.ts');
    await rm(join(root, 'unstaged-delete.ts'));
    await rm(join(root, 'deleted space.ts'));
    await rm(join(root, 'branch-only.ts'));
    await writeFile(join(root, 'untracked.ts'), 'export {};\n');
    await writeFile(join(root, 'with space.ts'), 'export {};\n');
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'inner.ts'), 'export {};\n');
    if (!hasOriginMain) git('update-ref', '-d', 'refs/remotes/origin/main');

    return {
        check: (...arguments_) =>
            assertExplicitFiles(
                root,
                arguments_.map((argument) => ({ argument, path: argument })),
                (gitArguments) => Promise.resolve(git(...gitArguments)),
            ),
    };
}

describe('assertExplicitFiles', () => {
    it('accepts files on disk, untracked ones and names with spaces included', async () => {
        const { check } = await fixtureRepo();
        await expect(
            check('kept.ts', 'moved.ts', 'untracked.ts', 'with space.ts', 'src/inner.ts'),
        ).resolves.toBeUndefined();
    });

    it('accepts paths Git records as deleted, so they still select the tests that reference them', async () => {
        const { check } = await fixtureRepo();
        await expect(
            check(
                'committed-delete.ts',
                'renamed.ts',
                'staged-delete.ts',
                'unstaged-delete.ts',
                'branch-only.ts',
                'deleted space.ts',
            ),
        ).resolves.toBeUndefined();
    });

    it('still rejects a mistyped path where no origin/main exists, as in a pull request CI checkout', async () => {
        // The CI unit job checks out only the pull request's merge commit, so `merge-base origin/main` has no ref.
        const { check } = await fixtureRepo({ hasOriginMain: false });
        await expect(check('kept.tsx')).rejects.toMatchObject({ exitCode: 2 });
        await expect(check('unstaged-delete.ts')).resolves.toBeUndefined();
    });

    it('rejects a mistyped path, naming only the bad argument', async () => {
        const { check } = await fixtureRepo();
        const failure = check('kept.ts', 'kept.tsx');
        await expect(failure).rejects.toMatchObject({ exitCode: 2 });
        await expect(failure).rejects.toThrow(
            '"kept.tsx": no such file, and Git records no deletion at this path',
        );
        await expect(failure).rejects.not.toThrow('"kept.ts"');
        await expect(failure).rejects.not.toThrow('one path per argument');
    });

    it('rejects paths joined into one argument by a space or a newline', async () => {
        const { check } = await fixtureRepo();
        for (const joined of ['kept.ts untracked.ts', 'kept.ts\nuntracked.ts']) {
            // eslint-disable-next-line no-await-in-loop -- one rejection per joined form
            await expect(check(joined)).rejects.toThrow(
                new RegExp(
                    String.raw`${JSON.stringify(joined).replaceAll('\\', '\\\\')}[\s\S]*Pass one path per argument`,
                    'u',
                ),
            );
        }
    });

    it('rejects a directory instead of checking nothing inside it', async () => {
        const { check } = await fixtureRepo();
        await expect(check('src')).rejects.toThrow('"src": a directory; pass the files inside it');
    });
});

describe('check command', () => {
    it('exits 2 for a missing explicit path instead of reporting a green "0 changed"', async () => {
        let failure: { code: number; stderr: string; stdout: string } | undefined;
        try {
            await execFileAsync(
                'bun',
                ['.agents/skills/quality-check/scripts/check.ts', 'does/not/exist.ts', '--lint'],
                { cwd: repoRoot, encoding: 'utf8' },
            );
        } catch (error) {
            failure = error as typeof failure;
        }
        expect(failure?.code).toBe(2);
        expect(failure?.stderr).toContain('"does/not/exist.ts": no such file');
        expect(failure?.stdout).not.toContain('0 changed');
    });
});

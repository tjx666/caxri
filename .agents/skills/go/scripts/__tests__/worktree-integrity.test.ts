import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    assertCleanValidationStart,
    assertGitAncestor,
    assertGitCommitMissing,
    inspectWorktreeDelta,
    inspectWorktreeIntegrity,
    resolveGitCommit,
} from '../worktree-integrity';

const directories: string[] = [];

async function repo(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-go-integrity-'));
    directories.push(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: directory });
    await writeFile(join(directory, '.gitignore'), 'ignored/\n', 'utf8');
    await writeFile(join(directory, 'source.ts'), 'export const value = 1;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: directory });
    return directory;
}

afterEach(async () => {
    const paths = [...directories];
    directories.length = 0;
    await Promise.all(paths.map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('Go validation worktree integrity', () => {
    it('derives HEAD from Git and rejects a forged expected SHA', async () => {
        const directory = await repo();
        const integrity = await inspectWorktreeIntegrity(directory);

        expect(integrity.clean).toBe(true);
        expect(integrity.headSha).toMatch(/^[0-9a-f]{40}$/u);
        expect(() => assertCleanValidationStart(integrity, 'forged-head')).toThrow(
            'recorded worktree is',
        );
    });

    it('ignores ignored artifacts but detects tracked and non-ignored source changes', async () => {
        const directory = await repo();
        await mkdir(join(directory, 'ignored'));
        await writeFile(join(directory, 'ignored', 'build.log'), 'generated\n', 'utf8');
        expect((await inspectWorktreeIntegrity(directory)).clean).toBe(true);

        await writeFile(join(directory, 'source.ts'), 'export const value = 2;\n', 'utf8');
        expect((await inspectWorktreeIntegrity(directory)).clean).toBe(false);
    });

    it('measures the committed file delta between issue boundaries', async () => {
        const directory = await repo();
        const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: directory,
            encoding: 'utf8',
        }).trim();
        await writeFile(join(directory, 'source.ts'), 'export const value = 2;\n', 'utf8');
        await writeFile(join(directory, 'second.ts'), 'export const second = true;\n', 'utf8');
        execFileSync('git', ['add', '.'], { cwd: directory });
        execFileSync('git', ['commit', '-qm', 'second issue'], { cwd: directory });

        await expect(inspectWorktreeDelta(directory, baseSha)).resolves.toMatchObject({
            commitCount: 1,
            fileCount: 2,
        });
    });

    it('distinguishes missing commits and verifies canonical ancestry', async () => {
        const directory = await repo();
        const parent = await resolveGitCommit(directory, 'HEAD');
        await writeFile(join(directory, 'source.ts'), 'export const value = 2;\n', 'utf8');
        execFileSync('git', ['add', '.'], { cwd: directory });
        execFileSync('git', ['commit', '-qm', 'descendant'], { cwd: directory });
        const descendant = await resolveGitCommit(directory, 'HEAD');

        await expect(assertGitCommitMissing(directory, 'f'.repeat(40))).resolves.toBeUndefined();
        await expect(assertGitCommitMissing(directory, parent)).rejects.toThrow(
            'cannot amend a valid commit',
        );
        await expect(assertGitAncestor(directory, parent, descendant)).resolves.toBeUndefined();
        await expect(assertGitAncestor(directory, descendant, parent)).rejects.toThrow(
            'not an ancestor',
        );
    });
});

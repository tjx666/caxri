import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { exportChecksDiffBase } from '../ci-checks-diff-base';

const execFileAsync = promisify(execFile);
const fixtureRoots: string[] = [];

async function git(cwd: string, ...arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', arguments_, { cwd });
    return stdout.trim();
}

async function commitFile(cwd: string, name: string, content: string): Promise<string> {
    await writeFile(join(cwd, name), content, 'utf8');
    await git(cwd, 'add', name);
    await git(cwd, 'commit', '-m', name);
    return git(cwd, 'rev-parse', 'HEAD');
}

/**
 * The run was queued with `payloadBase`, then another PR landed and GitHub recomputed the merge ref on `advancedBase`.
 */
async function driftedMergeCheckout() {
    const root = await mkdtemp(join(tmpdir(), 'caxri-diff-base-'));
    fixtureRoots.push(root);
    const repo = join(root, 'repo');
    await git(root, 'init', '-b', 'main', repo);
    await git(repo, 'config', 'user.name', 'Caxri CI');
    await git(repo, 'config', 'user.email', 'ci@caxri.test');
    const payloadBase = await commitFile(repo, 'base.txt', 'base\n');
    await git(repo, 'checkout', '-b', 'feature');
    const headRevision = await commitFile(repo, 'feature.txt', 'feature\n');
    await git(repo, 'checkout', 'main');
    const advancedBase = await commitFile(repo, 'landed.txt', 'another PR landed\n');
    await git(repo, 'merge', '--no-ff', 'feature', '-m', 'synthetic merge');
    const githubEnvironment = join(root, 'github-env');
    await writeFile(githubEnvironment, '', 'utf8');
    return { advancedBase, githubEnv: githubEnvironment, headRevision, payloadBase, repo };
}

afterEach(async () => {
    const pending = [...fixtureRoots];
    fixtureRoots.length = 0;
    await Promise.all(pending.map((root) => rm(root, { force: true, recursive: true })));
});

describe('checks diff base export', () => {
    it('diffs a pull request against the merge ref base, not the stale payload base', async () => {
        const fixture = await driftedMergeCheckout();

        await expect(
            exportChecksDiffBase(
                {
                    ...process.env,
                    CAXRI_CHECKS_BASE_REVISION: fixture.payloadBase,
                    CAXRI_CHECKS_HEAD_REVISION: fixture.headRevision,
                    CAXRI_GITHUB_TOKEN: 'test-token',
                    GITHUB_ENV: fixture.githubEnv,
                    GITHUB_EVENT_NAME: 'pull_request',
                },
                fixture.repo,
            ),
        ).resolves.toBe(fixture.advancedBase);
        expect(await readFile(fixture.githubEnv, 'utf8')).toBe(
            `CAXRI_REACT_DOCTOR_BASE=${fixture.advancedBase}\n`,
        );
    });

    it('keeps the payload before revision for a push', async () => {
        const fixture = await driftedMergeCheckout();

        await exportChecksDiffBase(
            {
                ...process.env,
                CAXRI_CHECKS_BASE_REVISION: fixture.payloadBase,
                GITHUB_ENV: fixture.githubEnv,
                GITHUB_EVENT_NAME: 'push',
            },
            fixture.repo,
        );
        expect(await readFile(fixture.githubEnv, 'utf8')).toBe(
            `CAXRI_REACT_DOCTOR_BASE=${fixture.payloadBase}\n`,
        );
    });
});

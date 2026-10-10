import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { AGENT_STATE_ENVIRONMENT_KEYS } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { execFileAsync } from '../exec';
import {
    cleanup,
    didRemoveCreatedRunRoot,
    RUNNER_AGENT_ENVIRONMENT_POLICIES,
    shortTemporaryLinkPath,
    validateRunnerOwner,
} from '../self-hosted-runner';

/**
 * Overrides every runner path that the real setup action exports into hosted test processes.
 */
function cleanupFixtureEnvironment(input: {
    githubSummary: string;
    owner: string;
    runnerTemp: string;
    runRoot: string;
    workspace: string;
}): NodeJS.ProcessEnv {
    return {
        ...process.env,
        CAXRI_RUNNER_OWNER: input.owner,
        CAXRI_RUNNER_ROOT: input.runRoot,
        GITHUB_STEP_SUMMARY: input.githubSummary,
        GITHUB_WORKSPACE: input.workspace,
        RUNNER_TEMP: input.runnerTemp,
    };
}

describe('self-hosted E2E runner Agent state isolation', () => {
    it('redirects every provider state key the shared protocol table names', () => {
        expect(
            Object.fromEntries(
                Object.entries(RUNNER_AGENT_ENVIRONMENT_POLICIES).map(([provider, policy]) => [
                    provider,
                    policy.environmentKeys,
                ]),
            ),
        ).toEqual(AGENT_STATE_ENVIRONMENT_KEYS);
    });
});

describe('self-hosted E2E runner ownership', () => {
    it('accepts only bounded portable run owners', () => {
        expect(validateRunnerOwner('caxri-123-2-parallel-safe')).toBe('caxri-123-2-parallel-safe');
        expect(() => validateRunnerOwner('caxri-123-2-../../home')).toThrow(
            'Invalid CAXRI_RUNNER_OWNER',
        );
    });

    it('keeps the short TMPDIR link inside the macOS Unix socket path budget', () => {
        expect(shortTemporaryLinkPath('caxri-31688024802-1-parallel-safe')).toBe(
            '/private/tmp/caxri-31688024802-1-parallel-safe',
        );
        expect(() => shortTemporaryLinkPath(`caxri-1-1-${'x'.repeat(60)}`)).toThrow(
            'Short temporary link path exceeds the Unix socket budget',
        );
    });

    it('rolls back only its run root when preflight fails after creating it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-runner-prepare-'));
        const workspace = join(root, 'workspace');
        const runnerTemporary = join(root, 'runner-temp');
        const owner = `caxri-${Date.now()}-${process.pid}-prepare-rollback`;
        const temporaryLink = shortTemporaryLinkPath(owner);
        const runRoot = join(runnerTemporary, owner);
        const githubEnvironment = join(root, 'github-env');
        const githubSummary = join(root, 'github-summary');
        const leaseStateDirectory = join(workspace, '.git', 'caxri-worktree-state');
        const staleLeasePath = join(leaseStateDirectory, 'desktop-lease.json');

        try {
            await mkdir(workspace, { recursive: true });
            await mkdir(runnerTemporary, { recursive: true });
            await writeFile(githubEnvironment, '');
            await writeFile(githubSummary, '');
            await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });
            await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
                cwd: workspace,
            });
            await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: workspace });
            await writeFile(join(workspace, 'fixture.txt'), 'fixture\n');
            await execFileAsync('git', ['add', 'fixture.txt'], { cwd: workspace });
            await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: workspace });
            await mkdir(leaseStateDirectory, { recursive: true });
            await writeFile(
                staleLeasePath,
                JSON.stringify({
                    acquiredAt: new Date().toISOString(),
                    identity: 'dead-previous-ci-owner',
                    label: 'stale previous CI coordinator',
                    owner: 'caxri-41-1-e2e',
                    pid: process.pid,
                    token: 'stale-token',
                    worktreeId: 'stale-worktree',
                    worktreePath: workspace,
                }),
            );
            const { stdout: head } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
                cwd: workspace,
            });
            /**
             * A non-link collision proves rollback cannot remove a path it did not create.
             */
            await mkdir(temporaryLink, { recursive: false });

            await expect(
                execFileAsync(
                    'bun',
                    [
                        'run',
                        new URL('../self-hosted-runner.ts', import.meta.url).pathname,
                        'prepare',
                    ],
                    {
                        cwd: workspace,
                        env: {
                            ...process.env,
                            CAXRI_DESKTOP_LEASE_OWNER: owner,
                            CAXRI_EXPECTED_HEAD: head.trim(),
                            CAXRI_RUNNER_AGENT_DISCOVERY: 'blocked',
                            CAXRI_RUNNER_OWNER: owner,
                            GITHUB_ENV: githubEnvironment,
                            GITHUB_STEP_SUMMARY: githubSummary,
                            GITHUB_WORKSPACE: workspace,
                            RUNNER_ARCH: 'ARM64',
                            RUNNER_ENVIRONMENT: 'self-hosted',
                            RUNNER_NAME: 'test-runner',
                            RUNNER_OS: 'macOS',
                            RUNNER_TEMP: runnerTemporary,
                        },
                    },
                ),
            ).rejects.toThrow('EEXIST');

            await expect(access(runRoot)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(access(staleLeasePath)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(access(temporaryLink)).resolves.toBeUndefined();
        } finally {
            await rm(temporaryLink, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves a replaced run root whose marker no longer belongs to the current owner', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-runner-rollback-marker-'));
        const runnerTemporary = join(root, 'runner-temp');
        const owner = `caxri-${Date.now()}-${process.pid}-rollback-marker`;
        const runRoot = join(runnerTemporary, owner);

        try {
            await mkdir(runRoot, { recursive: true });
            await writeFile(
                join(runRoot, 'owner.json'),
                `${JSON.stringify({ owner: 'caxri-1-1-other' })}\n`,
            );

            await expect(didRemoveCreatedRunRoot(runnerTemporary, runRoot, owner)).rejects.toThrow(
                'Created runner job root marker does not match',
            );
            await expect(access(runRoot)).resolves.toBeUndefined();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves owned profiles and links when process teardown is not verified', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-runner-cleanup-'));
        const workspace = join(root, 'workspace');
        const runnerTemporary = join(root, 'runner-temp');
        const owner = `caxri-${Date.now()}-${process.pid}-cleanup-continuation`;
        const runRoot = join(runnerTemporary, owner);
        const temporaryLink = shortTemporaryLinkPath(owner);
        const githubSummary = join(root, 'github-summary');

        try {
            await mkdir(workspace, { recursive: true });
            await mkdir(join(runRoot, 'tmp'), { recursive: true });
            await writeFile(join(runRoot, 'owner.json'), `${JSON.stringify({ owner })}\n`);
            await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });
            await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
                cwd: workspace,
            });
            await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: workspace });
            await writeFile(join(workspace, 'tracked.txt'), 'tracked\n');
            await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspace });
            await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: workspace });
            await writeFile(githubSummary, '');
            await symlink(join(runRoot, 'tmp'), temporaryLink);

            await expect(
                cleanup(
                    cleanupFixtureEnvironment({
                        githubSummary,
                        owner,
                        runnerTemp: runnerTemporary,
                        runRoot,
                        workspace,
                    }),
                    {
                        terminateOwnedProcesses: () =>
                            Promise.reject(new Error('injected earlier teardown failure')),
                    },
                ),
            ).rejects.toThrow('injected earlier teardown failure');

            await expect(access(temporaryLink)).resolves.toBeUndefined();
            await expect(access(runRoot)).resolves.toBeUndefined();
            expect(await readFile(githubSummary, 'utf8')).toContain(
                '| Cleanup stage failures | `1` |',
            );
            expect(await readFile(githubSummary, 'utf8')).toContain(
                '| Failed stages | `processes` |',
            );
        } finally {
            await rm(temporaryLink, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });

    it('removes Spotlight-excluded package output before verifying a clean workspace', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-runner-package-cleanup-'));
        const workspace = join(root, 'workspace');
        const runnerTemporary = join(root, 'runner-temp');
        const owner = `caxri-${Date.now()}-${process.pid}-package-cleanup`;
        const runRoot = join(runnerTemporary, owner);
        const packageOutput = join(workspace, 'release.noindex');
        const githubSummary = join(root, 'github-summary');

        try {
            await mkdir(join(runRoot, 'tmp'), { recursive: true });
            await mkdir(join(packageOutput, 'mac-arm64', 'Caxri.app'), { recursive: true });
            await writeFile(join(runRoot, 'owner.json'), `${JSON.stringify({ owner })}\n`);
            await writeFile(join(packageOutput, 'artifact.txt'), 'generated\n');
            await writeFile(githubSummary, '');
            await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });
            await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
                cwd: workspace,
            });
            await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: workspace });
            await writeFile(join(workspace, 'tracked.txt'), 'tracked\n');
            await execFileAsync('git', ['add', 'tracked.txt'], { cwd: workspace });
            await execFileAsync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: workspace });

            await expect(
                cleanup(
                    cleanupFixtureEnvironment({
                        githubSummary,
                        owner,
                        runnerTemp: runnerTemporary,
                        runRoot,
                        workspace,
                    }),
                    { terminateOwnedProcesses: () => Promise.resolve(0) },
                ),
            ).resolves.toBeUndefined();

            await expect(access(packageOutput)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves a foreign short TMPDIR link and fails closed', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-runner-foreign-link-'));
        const workspace = join(root, 'workspace');
        const runnerTemporary = join(root, 'runner-temp');
        const owner = `caxri-${Date.now()}-${process.pid}-foreign-link`;
        const runRoot = join(runnerTemporary, owner);
        const foreignTarget = join(root, 'foreign-tmp');
        const temporaryLink = shortTemporaryLinkPath(owner);
        const githubSummary = join(root, 'github-summary');

        try {
            await mkdir(workspace, { recursive: true });
            await mkdir(join(runRoot, 'tmp'), { recursive: true });
            await mkdir(foreignTarget, { recursive: true });
            await writeFile(join(runRoot, 'owner.json'), `${JSON.stringify({ owner })}\n`);
            await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });
            await writeFile(githubSummary, '');
            await symlink(foreignTarget, temporaryLink);

            await expect(
                cleanup(
                    cleanupFixtureEnvironment({
                        githubSummary,
                        owner,
                        runnerTemp: runnerTemporary,
                        runRoot,
                        workspace,
                    }),
                    { terminateOwnedProcesses: () => Promise.resolve(0) },
                ),
            ).rejects.toThrow(
                'Owned short temporary path must target the current runner job temporary directory',
            );

            await expect(access(temporaryLink)).resolves.toBeUndefined();
            await expect(access(runRoot)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(temporaryLink, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });

    it('preserves the first cleanup failure when writing the teardown summary also fails', async () => {
        const root = await mkdtemp(join(tmpdir(), 'caxri-runner-summary-failure-'));
        const workspace = join(root, 'workspace');
        const runnerTemporary = join(root, 'runner-temp');
        const owner = `caxri-${Date.now()}-${process.pid}-summary-failure`;
        const runRoot = join(runnerTemporary, owner);
        const temporaryLink = shortTemporaryLinkPath(owner);
        const summaryDirectory = join(root, 'summary-directory');

        try {
            await mkdir(workspace, { recursive: true });
            await mkdir(join(runRoot, 'tmp'), { recursive: true });
            await mkdir(summaryDirectory, { recursive: true });
            await writeFile(join(runRoot, 'owner.json'), `${JSON.stringify({ owner })}\n`);
            await execFileAsync('git', ['init', '--quiet'], { cwd: workspace });
            await symlink(join(runRoot, 'tmp'), temporaryLink);

            await expect(
                cleanup(
                    cleanupFixtureEnvironment({
                        githubSummary: summaryDirectory,
                        owner,
                        runnerTemp: runnerTemporary,
                        runRoot,
                        workspace,
                    }),
                    {
                        terminateOwnedProcesses: () =>
                            Promise.reject(new Error('first cleanup failure')),
                    },
                ),
            ).rejects.toThrow('first cleanup failure');

            await expect(access(temporaryLink)).resolves.toBeUndefined();
            await expect(access(runRoot)).resolves.toBeUndefined();
        } finally {
            await rm(temporaryLink, { recursive: true, force: true });
            await rm(root, { recursive: true, force: true });
        }
    });
});

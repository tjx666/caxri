import type { GitRepositorySummary } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
import { ExternalStatusCliError } from '../../external-status';
import { chooseMergeMethod } from '../../external-status/merge-method';
import { mergeGitHubPullRequest } from '../pull-request-merge';

const HEAD = 'a'.repeat(40);
const repo = { rootPath: '/workspace/widget' } as GitRepositorySummary;

function harness(
    settings: Record<string, boolean>,
    mergeFailure?: Error,
): {
    forget: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn<ExternalStatusRunner>>;
    merge: () => ReturnType<typeof mergeGitHubPullRequest>;
    failureRecords: () => unknown[];
} {
    const forget = vi.fn();
    const write = vi.fn<StructuredLogger['write']>();
    const run = vi.fn<ExternalStatusRunner>((_source, arguments_) => {
        if (arguments_[0] === 'repo') return Promise.resolve(JSON.stringify(settings));
        return mergeFailure ? Promise.reject(mergeFailure) : Promise.resolve('');
    });
    return {
        forget,
        run,
        merge: () =>
            mergeGitHubPullRequest(
                repo,
                { number: 42, headSha: HEAD },
                {
                    forget,
                    logger: { write } as unknown as StructuredLogger,
                    originRemote: () => Promise.resolve('git@github.com:acme/widget.git'),
                    run,
                },
            ),
        failureRecords: () =>
            write.mock.calls
                .filter(([, event]) => event === logEventCatalog.git.githubCommandFailed)
                .map((call) => call[2]),
    };
}

describe('chooseMergeMethod', () => {
    it('prefers squash, then a merge commit, then rebase', () => {
        expect(
            chooseMergeMethod({
                squashMergeAllowed: true,
                mergeCommitAllowed: true,
                rebaseMergeAllowed: true,
            }),
        ).toBe('squash');
        expect(chooseMergeMethod({ mergeCommitAllowed: true, rebaseMergeAllowed: true })).toBe(
            'merge',
        );
        expect(chooseMergeMethod({ rebaseMergeAllowed: true })).toBe('rebase');
        expect(chooseMergeMethod({})).toBeUndefined();
    });
});

describe('mergeGitHubPullRequest', () => {
    it('merges with the allowed method pinned to the head the user saw, without deleting the branch', async () => {
        const { forget, merge, run } = harness({
            squashMergeAllowed: false,
            mergeCommitAllowed: true,
        });

        await expect(merge()).resolves.toEqual({
            method: 'merge',
            url: 'https://github.com/acme/widget/pull/42',
        });

        expect(run).toHaveBeenLastCalledWith(
            'gh',
            ['pr', 'merge', '42', '--repo', 'acme/widget', '--merge', '--match-head-commit', HEAD],
            '/workspace/widget',
        );
        expect(run.mock.calls.flatMap(([, arguments_]) => arguments_)).not.toContain(
            '--delete-branch',
        );
        expect(forget).toHaveBeenCalledWith('acme', 'widget', 42);
    });

    it("reports GitHub's own reason and still drops the stale record when the merge is refused", async () => {
        const { forget, merge } = harness(
            { squashMergeAllowed: true },
            new ExternalStatusCliError(
                'gh',
                'other',
                'X Pull request acme/widget#42 is not mergeable: the base branch policy prohibits the merge.\n',
            ),
        );

        await expect(merge()).rejects.toMatchObject({
            code: 'GIT',
            message:
                'Pull request acme/widget#42 is not mergeable: the base branch policy prohibits the merge.',
        });
        expect(forget).toHaveBeenCalledWith('acme', 'widget', 42);
    });

    it('refuses before calling GitHub when the repository allows no merge method', async () => {
        const { failureRecords, merge, run } = harness({});

        await expect(merge()).rejects.toMatchObject({
            message: 'This repository does not allow any merge method',
        });
        expect(run).toHaveBeenCalledTimes(1);
        expect(failureRecords()).toEqual([
            expect.objectContaining({
                fields: {
                    operation: 'pr.merge',
                    step: 'repo.view',
                    reason: 'no-merge-method',
                    exitCode: null,
                },
            }),
        ]);
    });

    /**
     * `gh` stderr, which the runner's error carries as its message, names the repository, the Pull Request, and
     * GitHub's policy text; `git.github_command_failed` keeps only the closed step, reason, and exit code.
     */
    it('logs the closed failure cause of a refused merge without the CLI message or argv', async () => {
        const { failureRecords, merge } = harness(
            { squashMergeAllowed: true },
            new ExternalStatusCliError(
                'gh',
                'other',
                'X Pull request acme/widget#42 is not mergeable: the base branch policy prohibits the merge.\n',
                1,
            ),
        );

        await expect(merge()).rejects.toMatchObject({ code: 'GIT' });

        expect(failureRecords()).toEqual([
            expect.objectContaining({
                fields: { operation: 'pr.merge', step: 'pr.merge', reason: 'other', exitCode: 1 },
            }),
        ]);
        const serialized = JSON.stringify(failureRecords());
        expect(serialized).not.toContain('acme');
        expect(serialized).not.toContain('widget');
        expect(serialized).not.toContain('base branch policy');
    });

    it('logs an unreadable merge-settings response as a closed invalid-response cause', async () => {
        const forget = vi.fn();
        const write = vi.fn();
        await expect(
            mergeGitHubPullRequest(
                repo,
                { number: 42, headSha: HEAD },
                {
                    forget,
                    logger: { write } as unknown as StructuredLogger,
                    originRemote: () => Promise.resolve('git@github.com:acme/widget.git'),
                    run: () => Promise.resolve('{"squashMergeAllowed": "acme/widget"'),
                },
            ),
        ).rejects.toMatchObject({ code: 'GIT' });

        expect(write).toHaveBeenCalledWith(
            'warn',
            logEventCatalog.git.githubCommandFailed,
            expect.objectContaining({
                fields: {
                    operation: 'pr.merge',
                    step: 'repo.view',
                    reason: 'invalid-response',
                    exitCode: null,
                },
            }),
        );
        expect(JSON.stringify(write.mock.calls)).not.toContain('acme/widget');
    });
});

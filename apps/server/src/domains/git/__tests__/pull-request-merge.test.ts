import type { GitRepositorySummary } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { ExternalStatusRunner } from '../../external-status';
import { ExternalStatusCliError } from '../../external-status';
import { chooseMergeMethod, mergeGitHubPullRequest } from '../pull-request-merge';

const HEAD = 'a'.repeat(40);
const repo = { rootPath: '/workspace/widget' } as GitRepositorySummary;

function harness(
    settings: Record<string, boolean>,
    mergeFailure?: Error,
): {
    forget: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn<ExternalStatusRunner>>;
    merge: () => ReturnType<typeof mergeGitHubPullRequest>;
} {
    const forget = vi.fn();
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
                    logger: { write: vi.fn() } as unknown as StructuredLogger,
                    originRemote: () => Promise.resolve('git@github.com:acme/widget.git'),
                    run,
                },
            ),
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
        const { merge, run } = harness({});

        await expect(merge()).rejects.toMatchObject({
            message: 'This repository does not allow any merge method',
        });
        expect(run).toHaveBeenCalledTimes(1);
    });
});

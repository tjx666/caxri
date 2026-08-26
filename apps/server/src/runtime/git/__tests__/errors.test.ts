import { describe, expect, it } from 'vitest';

import { describeGitFailure } from '../errors';

function failureWithStderr(stderr: string): unknown {
    return Object.assign(new Error('git failed'), { stderr });
}

/**
 * Sync (pull/push) stderr is mapped to actionable copy instead of leaking raw remote output; each case pins one mapping
 * the Git panel's Sync toast depends on.
 */
describe('describeGitFailure sync mappings', () => {
    it.each([
        [
            'There is no tracking information for the current branch.',
            'The current branch has no upstream branch to sync with.',
        ],
        [
            'fatal: The current branch feature has no upstream branch.',
            'The current branch has no upstream branch to sync with.',
        ],
        [
            'error: Your local changes to the following files would be overwritten by merge:',
            'Local changes block the pull. Commit, stash, or discard them first.',
        ],
        [
            'error: failed to push some refs\nhint: Updates were rejected (non-fast-forward)',
            'The push was rejected. Pull the remote changes first.',
        ],
        [
            'hint: You have divergent branches and need to specify how to reconcile them.',
            'Local and remote history diverged. Set a pull strategy (merge or rebase) and try again.',
        ],
        [
            'fatal: Could not read from remote repository.',
            'Unable to reach the remote repository. Check the remote URL and your credentials.',
        ],
        [
            'fatal: Authentication failed for https://example.com/repo.git',
            'Unable to reach the remote repository. Check the remote URL and your credentials.',
        ],
    ])('maps %j', (stderr, expected) => {
        expect(describeGitFailure(failureWithStderr(stderr))).toBe(expected);
    });

    it('falls back to the generic wording for unrecognized remote stderr', () => {
        expect(describeGitFailure(failureWithStderr('remote: internal server error'))).toBe(
            'The Git operation failed. See Runtime logs for details.',
        );
    });
});

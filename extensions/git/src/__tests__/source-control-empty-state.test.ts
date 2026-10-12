import './host-api.fixture';

import { describe, expect, it } from 'vitest';

import { DETACHED_BRANCH } from '../repo-row-labels';
import { emptyStateForMode, withRetryHint } from '../source-control-empty-state';
import { repo } from './git-provider.fixture';

describe('Source Control empty states', () => {
    it('names Refresh as the way out of a failed pull request lookup', () => {
        expect(withRetryHint('Unable to load pull request changes.')).toBe(
            'Unable to load pull request changes. Refresh to retry.',
        );
        expect(withRetryHint('GitHub CLI is not signed in')).toBe(
            'GitHub CLI is not signed in. Refresh to retry.',
        );
        // A message that already names the step is not told twice.
        expect(withRetryHint('Check remote access and refresh.')).toBe(
            'Check remote access and refresh.',
        );
        expect(emptyStateForMode('pull-request', repo, undefined, true, undefined)).toEqual({
            emptyMessage: 'Unable to load pull request changes. Refresh to retry.',
        });
    });

    it('explains a detached HEAD in Pull Request mode instead of loading forever', () => {
        expect(
            emptyStateForMode(
                'pull-request',
                { ...repo, branch: DETACHED_BRANCH },
                undefined,
                undefined,
                undefined,
            ),
        ).toEqual({
            emptyMessage: 'Detached HEAD has no pull request. Switch to a branch to see one.',
        });
    });

    it('still loads the pull request of a branch', () => {
        expect(emptyStateForMode('pull-request', repo, undefined, undefined, undefined)).toEqual({
            emptyMessage: 'Loading pull request changes…',
            isLoading: true,
        });
        expect(emptyStateForMode('pull-request', repo, undefined, undefined, null)).toEqual({
            emptyMessage: 'No pull request for this branch.',
        });
    });
});

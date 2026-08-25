import { describe, expect, it } from 'vitest';

import { describeAheadBehind, describePullRequestSummary } from '../git-repo-summary-text';

describe('describeAheadBehind', () => {
    it('describes both counts even when zero', () => {
        expect(describeAheadBehind(0, 0)).toBe('0 ahead, 0 behind');
    });

    it('describes a repository ahead of and behind the remote', () => {
        expect(describeAheadBehind(2, 1)).toBe('2 ahead, 1 behind');
    });
});

describe('describePullRequestSummary', () => {
    it('names the pull request number and title', () => {
        expect(describePullRequestSummary({ number: 42, title: 'Fix thing' })).toBe(
            'Pull request #42: Fix thing',
        );
    });
});

import type { GitDiffDocument } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    isResolvedGitDiff,
    RESOLVED_GIT_DIFF_ACTION_LABEL,
    RESOLVED_GIT_DIFF_PENDING_LABEL,
    RESOLVED_GIT_DIFF_REASON,
    resolvedGitDiffActionLabel,
} from '../git-diff-resolution';

const document: GitDiffDocument = {
    format: 'contents',
    modified: 'after',
    original: 'before',
    path: 'tracked.txt',
};

describe('isResolvedGitDiff', () => {
    it('reports a file that no longer differs once this surface has read it', () => {
        expect(
            isResolvedGitDiff({ document: null, isError: false, isFetchedAfterMount: true }),
        ).toBe(true);
    });

    it('waits for its own read instead of trusting a cached verdict from a previous mount', () => {
        expect(
            isResolvedGitDiff({ document: null, isError: false, isFetchedAfterMount: false }),
        ).toBe(false);
    });

    it('never turns a failed read into a successful "no changes"', () => {
        expect(
            isResolvedGitDiff({ document: null, isError: true, isFetchedAfterMount: true }),
        ).toBe(false);
    });

    it('stays out of the way while a diff is present', () => {
        expect(isResolvedGitDiff({ document, isError: false, isFetchedAfterMount: true })).toBe(
            false,
        );
        expect(
            isResolvedGitDiff({ document: undefined, isError: false, isFetchedAfterMount: false }),
        ).toBe(false);
    });
});

describe('resolvedGitDiffActionLabel', () => {
    it('distinguishes an idle check from one in flight', () => {
        expect(resolvedGitDiffActionLabel(false)).toBe(RESOLVED_GIT_DIFF_ACTION_LABEL);
        expect(resolvedGitDiffActionLabel(true)).toBe(RESOLVED_GIT_DIFF_PENDING_LABEL);
        expect(RESOLVED_GIT_DIFF_ACTION_LABEL).not.toBe(RESOLVED_GIT_DIFF_PENDING_LABEL);
    });
});

describe('RESOLVED_GIT_DIFF_REASON', () => {
    it('names what happened to the file rather than what the app did to the tab', () => {
        expect(RESOLVED_GIT_DIFF_REASON).toContain('committed or undone');
        expect(RESOLVED_GIT_DIFF_REASON).not.toContain('closed');
    });
});

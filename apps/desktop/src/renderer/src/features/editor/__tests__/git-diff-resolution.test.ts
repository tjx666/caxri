import type { GitDiffDocument } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    RESOLVED_GIT_DIFF_ACTION_LABEL,
    RESOLVED_GIT_DIFF_PENDING_LABEL,
    RESOLVED_GIT_DIFF_REASON,
    resolvedGitDiffActionLabel,
    resolveNullGitDiffState,
} from '../git-diff-resolution';

const document: GitDiffDocument = {
    format: 'contents',
    modified: 'after',
    original: 'before',
    path: 'tracked.txt',
};

describe('resolveNullGitDiffState', () => {
    it('reports a file that no longer differs once this surface has read it', () => {
        expect(
            resolveNullGitDiffState({ document: null, isError: false, isFetchedAfterMount: true }),
        ).toBe('resolved');
    });

    it('waits for its own read instead of trusting a cached verdict from a previous mount', () => {
        expect(
            resolveNullGitDiffState({ document: null, isError: false, isFetchedAfterMount: false }),
        ).toBe('pending');
    });

    it('never turns a failed read into a successful "no changes"', () => {
        expect(
            resolveNullGitDiffState({ document: null, isError: true, isFetchedAfterMount: true }),
        ).toBe('failed');
    });

    it('reports a failed read over a cached null as a failure rather than a pending one', () => {
        expect(
            resolveNullGitDiffState({ document: null, isError: true, isFetchedAfterMount: false }),
        ).toBe('failed');
    });

    it('stays out of the way while a diff is present', () => {
        expect(
            resolveNullGitDiffState({ document, isError: false, isFetchedAfterMount: true }),
        ).toBe('pending');
        expect(
            resolveNullGitDiffState({
                document: undefined,
                isError: false,
                isFetchedAfterMount: false,
            }),
        ).toBe('pending');
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
        expect(RESOLVED_GIT_DIFF_REASON).toBe(
            'This file no longer differs from what the diff compared. The change was committed or undone.',
        );
        expect(RESOLVED_GIT_DIFF_REASON).not.toContain('closed');
    });
});

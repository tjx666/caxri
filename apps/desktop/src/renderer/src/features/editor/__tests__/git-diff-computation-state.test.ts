import { describe, expect, it } from 'vitest';

import { editorLoadReducer, initialEditorLoadState } from '../editor-load-state';
import {
    DIFF_STALL_REASON,
    DIFF_WORKER_NOT_STARTED_REASON,
    gitDiffComputationAction,
} from '../git-diff-computation-state';

describe('Git diff computation state', () => {
    it('turns a stall into a failure the user can read and act on', () => {
        const state = editorLoadReducer(
            initialEditorLoadState,
            gitDiffComputationAction('stalled', 0),
        );

        expect(state).toEqual({
            attempt: 0,
            reason: DIFF_STALL_REASON,
            status: 'failed',
            tone: 'failed',
        });
    });

    it('never lets the failure sentence be read as "no changes"', () => {
        expect(DIFF_STALL_REASON).not.toMatch(/unchanged|no changes|identical/i);
        expect(DIFF_STALL_REASON).toMatch(/never finished/);
    });

    it('names the worker when this window already knows none of them started', () => {
        const state = editorLoadReducer(
            initialEditorLoadState,
            gitDiffComputationAction('worker-not-started', 0),
        );

        expect(state).toEqual({
            attempt: 0,
            reason: DIFF_WORKER_NOT_STARTED_REASON,
            status: 'failed',
            tone: 'failed',
        });
        // Retry is only worth pressing because it releases that worker; the sentence has to say so.
        expect(DIFF_WORKER_NOT_STARTED_REASON).toMatch(/Retry/);
        expect(DIFF_WORKER_NOT_STARTED_REASON).not.toMatch(/unchanged|no changes|identical/i);
    });

    it('returns to the diff once a retried comparison answers', () => {
        const stalled = editorLoadReducer(
            initialEditorLoadState,
            gitDiffComputationAction('stalled', 0),
        );
        const retrying = editorLoadReducer(stalled, { type: 'retried' });
        expect(retrying).toEqual({ attempt: 1, status: 'loading' });

        expect(editorLoadReducer(retrying, gitDiffComputationAction('computed', 1))).toEqual({
            attempt: 1,
            status: 'ready',
        });
    });

    it('stays failed when a retry stalls again instead of falling silent', () => {
        const stalled = editorLoadReducer(
            initialEditorLoadState,
            gitDiffComputationAction('stalled', 0),
        );
        const retrying = editorLoadReducer(stalled, { type: 'retried' });

        expect(editorLoadReducer(retrying, gitDiffComputationAction('stalled', 1))).toEqual({
            attempt: 1,
            reason: DIFF_STALL_REASON,
            status: 'failed',
            tone: 'failed',
        });
    });

    it('discards the outcome of an attempt the user already abandoned', () => {
        const stalled = editorLoadReducer(
            initialEditorLoadState,
            gitDiffComputationAction('stalled', 0),
        );
        const retrying = editorLoadReducer(stalled, { type: 'retried' });

        expect(editorLoadReducer(retrying, gitDiffComputationAction('stalled', 0))).toBe(retrying);
        expect(editorLoadReducer(retrying, gitDiffComputationAction('computed', 0))).toBe(retrying);
    });
});

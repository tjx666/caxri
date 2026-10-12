import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import type { EditorLoadState, EditorLoadTone } from '../editor-load-state';
import {
    EDITOR_LOAD_FAILURE_REASON_KEY,
    editorLoadReducer,
    editorRenderFailureReason,
    initialEditorLoadState,
} from '../editor-load-state';

function failed(
    attempt: number,
    reason = 'Could not open this file. The file no longer exists.',
    tone: EditorLoadTone = 'failed',
) {
    return { type: 'failed', attempt, reason, tone } as const;
}

describe('editorLoadReducer', () => {
    it('starts out loading with nothing to report', () => {
        expect(initialEditorLoadState).toEqual({ attempt: 0, status: 'loading' });
    });

    it('replaces loading with a failure carrying the reason to show', () => {
        const state = editorLoadReducer(initialEditorLoadState, failed(0));
        expect(state.status).toBe('failed');
        expect(state).toHaveProperty(
            'reason',
            'Could not open this file. The file no longer exists.',
        );
    });

    it('keeps a cancelled read apart from a real failure', () => {
        const state = editorLoadReducer(
            initialEditorLoadState,
            failed(0, 'Opening this file was interrupted.', 'interrupted'),
        );
        expect(state).toMatchObject({ status: 'failed', tone: 'interrupted' });
    });

    it('replaces loading with success', () => {
        expect(
            editorLoadReducer(initialEditorLoadState, { type: 'succeeded', attempt: 0 }),
        ).toEqual({ attempt: 0, status: 'ready' });
    });

    it('returns to loading on retry and names a new attempt so the read re-runs', () => {
        const state = editorLoadReducer(editorLoadReducer(initialEditorLoadState, failed(0)), {
            type: 'retried',
        });
        expect(state).toEqual({ attempt: 1, status: 'loading' });
    });

    it('ignores the outcome of an attempt the user already retried past', () => {
        const retried = editorLoadReducer(editorLoadReducer(initialEditorLoadState, failed(0)), {
            type: 'retried',
        });
        expect(editorLoadReducer(retried, failed(0, 'stale'))).toBe(retried);
        expect(editorLoadReducer(retried, { type: 'succeeded', attempt: 0 })).toBe(retried);
    });

    it('accepts the outcome of the attempt now in flight', () => {
        const retried = editorLoadReducer(editorLoadReducer(initialEditorLoadState, failed(0)), {
            type: 'retried',
        });
        expect(editorLoadReducer(retried, { type: 'succeeded', attempt: 1 })).toEqual({
            attempt: 1,
            status: 'ready',
        });
    });

    it('clears a failure when the surface switches to another target', () => {
        const state = editorLoadReducer(editorLoadReducer(initialEditorLoadState, failed(0)), {
            type: 'restarted',
        });
        expect(state).toEqual({ attempt: 0, status: 'loading' });
    });

    it('keeps the same state object when nothing changes, so an effect dispatch cannot loop', () => {
        expect(editorLoadReducer(initialEditorLoadState, { type: 'restarted' })).toBe(
            initialEditorLoadState,
        );
        const ready: EditorLoadState = { attempt: 2, status: 'ready' };
        expect(editorLoadReducer(ready, { type: 'succeeded', attempt: 2 })).toBe(ready);
    });
});

describe('editorRenderFailureReason', () => {
    it('reads a lazy tab chunk that never arrived as a load failure', () => {
        expect(
            editorRenderFailureReason(
                new TypeError(
                    'Failed to fetch dynamically imported module: app://renderer/assets/preview-surface.js',
                ),
            ),
        ).toBe(EDITOR_LOAD_FAILURE_REASON_KEY);
        expect(
            editorRenderFailureReason(new Error('Unable to preload CSS for /assets/settings.css')),
        ).toBe(EDITOR_LOAD_FAILURE_REASON_KEY);
    });

    it('reads any other thrown value as the tab failing, without quoting it', () => {
        const reason = editorRenderFailureReason(new RangeError('secret source text'));
        expect(translate(reason)).toBe(
            'This tab ran into an error. Reloading the window usually fixes it.',
        );
        expect(translate(reason)).not.toContain('secret');
        expect(editorRenderFailureReason('Failed to fetch dynamically imported module')).toBe(
            reason,
        );
        expect(editorRenderFailureReason(undefined)).toBe(reason);
    });
});

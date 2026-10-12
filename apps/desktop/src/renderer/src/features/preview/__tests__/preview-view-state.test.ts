import { afterEach, describe, expect, it } from 'vitest';

import {
    clearPreviewViewStates,
    previewViewStateKey,
    readPreviewViewState,
    rememberPreviewViewState,
} from '../preview-view-state';

afterEach(() => clearPreviewViewStates());

describe('preview view state', () => {
    it('keeps two panes showing one file independent', () => {
        const left = previewViewStateKey('session-1', 'pane-1', '/p/data.csv');
        const right = previewViewStateKey('session-1', 'pane-2', '/p/data.csv');
        rememberPreviewViewState(left, { scrollTop: 120 });
        rememberPreviewViewState(right, { scrollTop: 40 });
        expect(readPreviewViewState(left)).toEqual({ scrollTop: 120 });
        expect(readPreviewViewState(right)).toEqual({ scrollTop: 40 });
    });

    it('merges partial updates, so a scroll keeps the PDF page and zoom', () => {
        const key = previewViewStateKey('session-1', 'pane-1', '/p/manual.pdf');
        rememberPreviewViewState(key, { pageNumber: 3, scaleValue: 'page-fit' });
        rememberPreviewViewState(key, { scrollTop: 900 });
        expect(readPreviewViewState(key)).toEqual({
            pageNumber: 3,
            scaleValue: 'page-fit',
            scrollTop: 900,
        });
    });

    it('evicts the least recently used preview past its bound', () => {
        const first = previewViewStateKey('session-1', 'pane-1', '/p/0.md');
        rememberPreviewViewState(first, { scrollTop: 1 });
        for (let index = 1; index <= 100; index += 1)
            rememberPreviewViewState(previewViewStateKey('session-1', 'pane-1', `/p/${index}.md`), {
                scrollTop: index,
            });
        expect(readPreviewViewState(first)).toBeUndefined();
        expect(
            readPreviewViewState(previewViewStateKey('session-1', 'pane-1', '/p/100.md')),
        ).toEqual({ scrollTop: 100 });
    });
});

import { describe, expect, it } from 'vitest';

import {
    decodeEditorDragPayload,
    EDITOR_DRAG_TYPE,
    encodeEditorDragPayload,
    hasEditorDragType,
    resolveEditorDropZone,
} from './editor-drop-zone';

const bounds = { width: 200, height: 100 };

describe('resolveEditorDropZone', () => {
    it('resolves center for a point in the middle of the group', () => {
        expect(resolveEditorDropZone(bounds, { x: 100, y: 50 })).toBe('center');
    });

    it('resolves left near the left edge', () => {
        expect(resolveEditorDropZone(bounds, { x: 5, y: 50 })).toBe('left');
    });

    it('resolves right near the right edge', () => {
        expect(resolveEditorDropZone(bounds, { x: 195, y: 50 })).toBe('right');
    });

    it('resolves up near the top edge', () => {
        expect(resolveEditorDropZone(bounds, { x: 100, y: 5 })).toBe('up');
    });

    it('resolves down near the bottom edge', () => {
        expect(resolveEditorDropZone(bounds, { x: 100, y: 95 })).toBe('down');
    });

    it('picks the nearest edge in a corner', () => {
        // Width 200 makes the horizontal distance-from-edge fraction (10/200 = 0.05) smaller than the vertical
        // fraction (15/100 = 0.15), so the nearest edge — left — wins even though both are within the threshold.
        expect(resolveEditorDropZone(bounds, { x: 10, y: 15 })).toBe('left');
    });

    it('treats a degenerate (zero-size) bounds as center', () => {
        expect(resolveEditorDropZone({ width: 0, height: 0 }, { x: 0, y: 0 })).toBe('center');
    });

    it('stays center just inside the edge threshold boundary', () => {
        // 26% from the left edge is outside the 25% edge band.
        expect(resolveEditorDropZone(bounds, { x: 52, y: 50 })).toBe('center');
    });
});

describe('hasEditorDragType', () => {
    it('accepts the Editor custom MIME type and ignores text/plain-only drags', () => {
        expect(hasEditorDragType([EDITOR_DRAG_TYPE, 'text/plain'])).toBe(true);
        expect(hasEditorDragType(['text/plain'])).toBe(false);
    });
});

describe('editor drag payload codec', () => {
    it('round-trips a payload with and without a source group', () => {
        expect(decodeEditorDragPayload(encodeEditorDragPayload({ path: '/repo/a.ts' }))).toEqual({
            path: '/repo/a.ts',
        });
        expect(
            decodeEditorDragPayload(
                encodeEditorDragPayload({ path: '/repo/a.ts', sourceGroupId: 'group-1' }),
            ),
        ).toEqual({ path: '/repo/a.ts', sourceGroupId: 'group-1' });
    });

    it('accepts a bare path (text/plain fallback) and rejects empty or malformed data', () => {
        expect(decodeEditorDragPayload('/repo/a.ts')).toEqual({ path: '/repo/a.ts' });
        expect(decodeEditorDragPayload('')).toBeUndefined();
        expect(decodeEditorDragPayload('{"sourceGroupId":"group-1"}')).toBeUndefined();
        expect(decodeEditorDragPayload('{"path":42}')).toBeUndefined();
    });
});

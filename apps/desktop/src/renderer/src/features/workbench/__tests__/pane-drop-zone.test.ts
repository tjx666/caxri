import { describe, expect, it } from 'vitest';

import {
    hasPaneTabDragType,
    PANE_TAB_DRAG_TYPE,
    resolvePaneDropZone,
    resolveTabDropIndex,
} from '../pane-drop-zone';

const bounds = { width: 200, height: 100 };

describe('resolvePaneDropZone', () => {
    it('resolves center for a point in the middle of the pane', () => {
        expect(resolvePaneDropZone(bounds, { x: 100, y: 50 })).toBe('center');
    });

    it('resolves left near the left edge', () => {
        expect(resolvePaneDropZone(bounds, { x: 5, y: 50 })).toBe('left');
    });

    it('resolves right near the right edge', () => {
        expect(resolvePaneDropZone(bounds, { x: 195, y: 50 })).toBe('right');
    });

    it('resolves up near the top edge', () => {
        expect(resolvePaneDropZone(bounds, { x: 100, y: 5 })).toBe('up');
    });

    it('resolves down near the bottom edge', () => {
        expect(resolvePaneDropZone(bounds, { x: 100, y: 95 })).toBe('down');
    });

    it('picks the nearest edge in a corner', () => {
        // Width 200 makes the horizontal distance-from-edge fraction (10/200 = 0.05) smaller than the vertical
        // fraction (15/100 = 0.15), so the nearest edge — left — wins even though both are within the threshold.
        expect(resolvePaneDropZone(bounds, { x: 10, y: 15 })).toBe('left');
    });

    it('treats a degenerate (zero-size) bounds as center', () => {
        expect(resolvePaneDropZone({ width: 0, height: 0 }, { x: 0, y: 0 })).toBe('center');
    });

    it('stays center just inside the edge threshold boundary', () => {
        // 26% from the left edge is outside the 25% edge band.
        expect(resolvePaneDropZone(bounds, { x: 52, y: 50 })).toBe('center');
    });
});

describe('hasPaneTabDragType', () => {
    it('accepts the pane tab MIME type and ignores text/plain-only drags', () => {
        expect(hasPaneTabDragType([PANE_TAB_DRAG_TYPE, 'text/plain'])).toBe(true);
        expect(hasPaneTabDragType(['text/plain'])).toBe(false);
    });
});

describe('resolveTabDropIndex', () => {
    const tabRects = [
        { left: 0, width: 100 },
        { left: 100, width: 100 },
        { left: 200, width: 100 },
    ];

    it('inserts before the first tab when dropped left of its midpoint', () => {
        expect(resolveTabDropIndex(tabRects, 30)).toBe(0);
    });

    it('inserts before the second tab when dropped left of its midpoint', () => {
        expect(resolveTabDropIndex(tabRects, 120)).toBe(1);
    });

    it('inserts after the last tab, past every midpoint', () => {
        expect(resolveTabDropIndex(tabRects, 280)).toBeUndefined();
    });

    it('appends to an empty bar', () => {
        expect(resolveTabDropIndex([], 50)).toBeUndefined();
    });
});

import { describe, expect, it } from 'vitest';

import { PROJECT_PATH_DRAG_TYPE } from '../../../lib/file-drag';
import {
    EDITOR_PATH_DRAG_TYPE,
    hasPaneTabDragType,
    PANE_TAB_DRAG_TYPE,
    resolvePaneDropIntent,
    resolvePaneDropZone,
    resolveTabDropIndex,
} from '../pane-drop-zone';

describe('resolvePaneDropIntent', () => {
    const terminal = { altKey: false, isTerminal: true, acceptsFileDrop: true, hasFilePath: false };
    const editorTypes = [PANE_TAB_DRAG_TYPE, EDITOR_PATH_DRAG_TYPE];
    it('accepts Project roots only in live Terminal inputs, including with Option held', () => {
        expect(resolvePaneDropIntent([PROJECT_PATH_DRAG_TYPE], terminal)).toBe('paste');
        expect(resolvePaneDropIntent([PROJECT_PATH_DRAG_TYPE], { ...terminal, altKey: true })).toBe(
            'paste',
        );
        expect(
            resolvePaneDropIntent([PROJECT_PATH_DRAG_TYPE], { ...terminal, isTerminal: false }),
        ).toBeUndefined();
        expect(
            resolvePaneDropIntent([PROJECT_PATH_DRAG_TYPE], {
                ...terminal,
                acceptsFileDrop: false,
            }),
        ).toBeUndefined();
    });
    it('pastes an Editor path unless Option requests pane placement', () => {
        expect(resolvePaneDropIntent(editorTypes, terminal)).toBe('paste');
        expect(resolvePaneDropIntent(editorTypes, { ...terminal, altKey: true })).toBe('place');
        expect(resolvePaneDropIntent(editorTypes, { ...terminal, isTerminal: false })).toBe(
            'place',
        );
    });
    it('does not turn rejected path drops on stopped Terminals into layout changes', () => {
        expect(
            resolvePaneDropIntent(editorTypes, { ...terminal, acceptsFileDrop: false }),
        ).toBeUndefined();
    });
    it('preserves Terminal, pathless document, and Files drag behavior', () => {
        expect(resolvePaneDropIntent([PANE_TAB_DRAG_TYPE], terminal)).toBe('place');
        expect(resolvePaneDropIntent([PANE_TAB_DRAG_TYPE], { ...terminal, altKey: true })).toBe(
            'place',
        );
        expect(resolvePaneDropIntent([], { ...terminal, hasFilePath: true })).toBe('paste');
        expect(resolvePaneDropIntent([], terminal)).toBeUndefined();
    });
});

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
        // fraction (15/100 = 0.15), so the nearest edge, left, wins even though both are within the threshold.
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

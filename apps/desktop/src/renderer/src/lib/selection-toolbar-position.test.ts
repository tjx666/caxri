import { describe, expect, it } from 'vitest';

import { SELECTION_TOOLBAR_GAP, selectionToolbarPosition } from './selection-toolbar-position';

describe('selectionToolbarPosition', () => {
    const bounds = { top: 100, bottom: 600, left: 0, right: 800 };
    const size = { width: 160, height: 28 };
    const line = (top: number, left = 300, right = 500) => ({
        top,
        bottom: top + 20,
        left,
        right,
    });

    it('centers the toolbar above the first selected line', () => {
        expect(
            selectionToolbarPosition({ bounds, first: line(300), last: line(340), size }),
        ).toEqual({ top: 300 - SELECTION_TOOLBAR_GAP - 28, left: 320 });
    });

    it('moves below the last line when the surface has no room above', () => {
        expect(
            selectionToolbarPosition({ bounds, first: line(110), last: line(150), size }),
        ).toEqual({ top: 170 + SELECTION_TOOLBAR_GAP, left: 320 });
    });

    it('stays inside the surface horizontally', () => {
        expect(
            selectionToolbarPosition({
                bounds,
                first: line(300, 0, 40),
                last: line(300, 0, 40),
                size,
            })?.left,
        ).toBe(SELECTION_TOOLBAR_GAP);
        expect(
            selectionToolbarPosition({
                bounds,
                first: line(300, 760, 800),
                last: line(300, 760, 800),
                size,
            })?.left,
        ).toBe(800 - SELECTION_TOOLBAR_GAP - 160);
    });

    it('hides while the selection is scrolled out of the surface', () => {
        expect(
            selectionToolbarPosition({ bounds, first: line(20), last: line(60), size }),
        ).toBeUndefined();
        expect(
            selectionToolbarPosition({ bounds, first: line(640), last: line(680), size }),
        ).toBeUndefined();
    });
});

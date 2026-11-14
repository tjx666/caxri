import { describe, expect, it } from 'vitest';

import { anchoredLayoutStart } from '../anchored-layout-start';

describe('anchoredLayoutStart', () => {
    it('lands a same-size move, as the keyboard causes, on the target at once', () => {
        expect(
            anchoredLayoutStart({
                currentHeight: 48,
                currentWidth: 360,
                targetHeight: 48,
                targetOriginX: 16,
                targetOriginY: 900,
            }),
        ).toEqual({ height: 48, originX: 16, originY: 900, width: 360 });
    });

    it('starts a resize at the current size on the target bottom edge', () => {
        // Growing from 48 to 160 while the keyboard also moved the row: the bottom edge is already the target's (1060).
        expect(
            anchoredLayoutStart({
                currentHeight: 48,
                currentWidth: 360,
                targetHeight: 160,
                targetOriginX: 16,
                targetOriginY: 900,
            }),
        ).toEqual({ height: 48, originX: 16, originY: 1012, width: 360 });
    });
});

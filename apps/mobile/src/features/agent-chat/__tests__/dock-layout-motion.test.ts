import { describe, expect, it } from 'vitest';

import { isDockResize } from '../dock-layout-motion';

describe('isDockResize', () => {
    it('treats a same-size move, as the keyboard causes, as no resize', () => {
        expect(
            isDockResize({
                currentHeight: 48,
                currentWidth: 360,
                targetHeight: 48,
                targetWidth: 360,
            }),
        ).toBe(false);
    });

    it('animates the panel opening or closing', () => {
        expect(
            isDockResize({
                currentHeight: 48,
                currentWidth: 360,
                targetHeight: 160,
                targetWidth: 360,
            }),
        ).toBe(true);
    });
});

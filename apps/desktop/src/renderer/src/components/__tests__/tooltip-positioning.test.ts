import { describe, expect, it } from 'vitest';

import { resolveTooltipCursorAnchor } from '../tooltip-positioning';

describe('tooltip cursor positioning', () => {
    it('captures the hover-open point once with the inline offset', () => {
        const point = { x: 100, y: 240 };
        const anchor = resolveTooltipCursorAnchor(true, 'trigger-hover', point);
        point.x = 500;
        point.y = 600;

        expect(anchor?.getBoundingClientRect()).toMatchObject({
            bottom: 240,
            height: 0,
            left: 110,
            right: 110,
            top: 240,
            width: 0,
            x: 110,
            y: 240,
        });
    });

    it('keeps focus-open and closed tooltips anchored to their element', () => {
        expect(
            resolveTooltipCursorAnchor(true, 'trigger-focus', { x: 100, y: 240 }),
        ).toBeUndefined();
        expect(
            resolveTooltipCursorAnchor(false, 'trigger-hover', { x: 100, y: 240 }),
        ).toBeUndefined();
        expect(resolveTooltipCursorAnchor(true, 'trigger-hover', undefined)).toBeUndefined();
    });
});

import { describe, expect, it } from 'vitest';

import {
    resolveCursorTooltipRestRemaining,
    resolveTooltipCursorAnchor,
    TOOLTIP_OPEN_DELAY_MS,
} from '../tooltip-positioning';

describe('tooltip cursor positioning', () => {
    it('captures the hover-open point once', () => {
        const point = { x: 100, y: 240 };
        const anchor = resolveTooltipCursorAnchor(true, 'trigger-hover', point);
        point.x = 500;
        point.y = 600;

        expect(anchor?.getBoundingClientRect()).toMatchObject({
            bottom: 240,
            height: 0,
            left: 100,
            right: 100,
            top: 240,
            width: 0,
            x: 100,
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

describe('cursor tooltip rest delay', () => {
    it('defers an open that arrives before the pointer rested for the full delay', () => {
        expect(resolveCursorTooltipRestRemaining(1000, 1000)).toBe(TOOLTIP_OPEN_DELAY_MS);
        expect(resolveCursorTooltipRestRemaining(1000, 1100)).toBe(TOOLTIP_OPEN_DELAY_MS - 100);
    });

    it('lets a rested or untracked pointer open at once', () => {
        expect(resolveCursorTooltipRestRemaining(1000, 1000 + TOOLTIP_OPEN_DELAY_MS)).toBe(0);
        expect(resolveCursorTooltipRestRemaining(1000, 1000 + TOOLTIP_OPEN_DELAY_MS - 10)).toBe(0);
        expect(resolveCursorTooltipRestRemaining(undefined, 1000)).toBe(0);
    });
});

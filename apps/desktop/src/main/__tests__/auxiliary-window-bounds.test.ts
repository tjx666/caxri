import type { Rectangle } from 'electron';
import { describe, expect, it } from 'vitest';

import { clampBoundsToWorkArea, resolveAuxiliaryWindowBounds } from '../auxiliary-window-bounds';

describe('clampBoundsToWorkArea', () => {
    const workArea: Rectangle = { x: 0, y: 0, width: 1_920, height: 1_080 };

    it('leaves bounds untouched when they already fit the work area', () => {
        const bounds = { x: 100, y: 80, width: 1_280, height: 760 };
        expect(clampBoundsToWorkArea(bounds, workArea)).toEqual(bounds);
    });

    it('shrinks width and height that exceed the work area', () => {
        expect(
            clampBoundsToWorkArea({ x: 0, y: 0, width: 3_000, height: 2_000 }, workArea),
        ).toEqual({ x: 0, y: 0, width: 1_920, height: 1_080 });
    });

    it('pulls an off-screen position back inside the work area', () => {
        expect(
            clampBoundsToWorkArea({ x: 1_900, y: 1_070, width: 1_280, height: 760 }, workArea),
        ).toEqual({ x: 640, y: 320, width: 1_280, height: 760 });
        expect(
            clampBoundsToWorkArea({ x: -500, y: -500, width: 1_280, height: 760 }, workArea),
        ).toEqual({ x: 0, y: 0, width: 1_280, height: 760 });
    });

    it('leaves an undefined default position alone, only clamping size', () => {
        expect(clampBoundsToWorkArea({ width: 3_000, height: 2_000 }, workArea)).toEqual({
            width: 1_920,
            height: 1_080,
        });
    });

    it('clamps against a non-origin work area, such as a secondary display', () => {
        const secondary: Rectangle = { x: 1_920, y: 0, width: 1_280, height: 800 };
        expect(
            clampBoundsToWorkArea({ x: 3_000, y: 700, width: 1_280, height: 760 }, secondary),
        ).toEqual({ x: 1_920, y: 40, width: 1_280, height: 760 });
    });
});

describe('resolveAuxiliaryWindowBounds', () => {
    it('returns undefined when nothing was ever remembered', () => {
        expect(
            resolveAuxiliaryWindowBounds(undefined, () => ({
                workArea: { x: 0, y: 0, width: 1_920, height: 1_080 },
            })),
        ).toBeUndefined();
    });

    it('clamps to whichever display the remembered rectangle matches', () => {
        const getDisplayMatching = (rectangle: Rectangle) => ({
            workArea:
                rectangle.x >= 1_920
                    ? { x: 1_920, y: 0, width: 1_280, height: 800 }
                    : { x: 0, y: 0, width: 1_920, height: 1_080 },
        });
        expect(
            resolveAuxiliaryWindowBounds(
                { x: 2_000, y: 50, width: 1_280, height: 760 },
                getDisplayMatching,
            ),
        ).toEqual({ x: 1_920, y: 40, width: 1_280, height: 760 });
    });

    it('probes at the origin when x/y are absent, so a first-run default still resolves a display', () => {
        const getDisplayMatching = (rectangle: Rectangle) => {
            expect(rectangle).toEqual({ x: 0, y: 0, width: 1_280, height: 760 });
            return { workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } };
        };
        expect(
            resolveAuxiliaryWindowBounds({ width: 1_280, height: 760 }, getDisplayMatching),
        ).toEqual({ width: 1_280, height: 760 });
    });

    it('shrinks a rectangle remembered from a larger, now-unplugged display', () => {
        const getDisplayMatching = () => ({ workArea: { x: 0, y: 0, width: 1_280, height: 800 } });
        expect(
            resolveAuxiliaryWindowBounds(
                { x: 200, y: 150, width: 2_560, height: 1_440 },
                getDisplayMatching,
            ),
        ).toEqual({ x: 0, y: 0, width: 1_280, height: 800 });
    });
});

import type { Rectangle } from 'electron';
import { describe, expect, it } from 'vitest';

import {
    AuxiliaryWindowBoundsMemory,
    clampBoundsToWorkArea,
    resolveAuxiliaryWindowBounds,
} from '../bounds';

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

describe('AuxiliaryWindowBoundsMemory', () => {
    const laptop: Rectangle = { x: 0, y: 25, width: 1_512, height: 920 };
    const external: Rectangle = { x: 1_512, y: 0, width: 2_560, height: 1_415 };

    /**
     * Stands in for `screen.getDisplayMatching` over whatever displays are attached at the moment of the call, so a
     * test can unplug a monitor between two opens the way the app keeps running through it.
     */
    function displays(attached: Rectangle[]) {
        const matcher = (rectangle: Rectangle) => ({
            workArea:
                attached.find(
                    (display) =>
                        rectangle.x >= display.x && rectangle.x < display.x + display.width,
                ) ?? attached[0],
        });
        return { attached, matcher };
    }

    it('opens at the default size until a window reports where it stood', () => {
        const memory = new AuxiliaryWindowBoundsMemory(
            { width: 1_320, height: 820 },
            displays([laptop]).matcher,
        );

        expect(memory.boundsForOpen()).toEqual({ width: 1_320, height: 820 });
        expect(memory.current()).toBeUndefined();
    });

    it('reopens at the remembered rectangle while its display is still attached', () => {
        const memory = new AuxiliaryWindowBoundsMemory(
            { width: 1_320, height: 820 },
            displays([laptop, external]).matcher,
        );
        const onExternal = { x: 2_000, y: 200, width: 1_320, height: 820 };
        memory.remember(onExternal);

        expect(memory.boundsForOpen()).toEqual(onExternal);
    });

    it('re-clamps on every reopen, so a window closed on an unplugged monitor reopens on a display attached now', () => {
        const screen = displays([laptop, external]);
        const memory = new AuxiliaryWindowBoundsMemory({ width: 1_320, height: 820 }, (rectangle) =>
            screen.matcher(rectangle),
        );
        const onExternal = { x: 2_000, y: 200, width: 1_320, height: 820 };
        memory.remember(onExternal);
        expect(memory.boundsForOpen()).toEqual(onExternal);

        screen.attached.splice(1, 1);

        expect(memory.boundsForOpen()).toEqual({ x: 192, y: 125, width: 1_320, height: 820 });
        /**
         * The raw rectangle survives, so quit persists it and the window returns to the monitor once it is back.
         */
        expect(memory.current()).toEqual(onExternal);
        screen.attached.push(external);
        expect(memory.boundsForOpen()).toEqual(onExternal);
    });

    it('clamps bounds loaded from the previous quit at open time, not at load time', () => {
        const screen = displays([laptop, external]);
        const memory = new AuxiliaryWindowBoundsMemory({ width: 1_280, height: 760 }, (rectangle) =>
            screen.matcher(rectangle),
        );
        memory.remember({ x: 3_000, y: 900, width: 2_000, height: 1_200 });
        screen.attached.splice(1, 1);

        expect(memory.boundsForOpen()).toEqual({ x: 0, y: 25, width: 1_512, height: 920 });
    });
});

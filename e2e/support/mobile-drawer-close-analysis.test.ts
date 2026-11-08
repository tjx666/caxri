import { describe, expect, it } from 'vitest';

import { analyseDrawerClose } from './mobile-drawer-close-analysis';
import type { GrayFrame } from './mobile-motion-analysis';

const geometry = { height: 24, width: 100 };
/**
 * The Session and the drawer share one background colour, as they do in the app.
 */
const BACKGROUND = 40;
const DRAWER_LEFT = 12;

/**
 * `[row, from, to, value]` rectangles of two rows each, except the pill.
 */
const SESSION_INK = [8, 14, 20].map((row) => [row, 2, 90, 160]);
const DRAWER_TEXT = [11, 17, 22].map((row, index) => [row, 16 + index * 4, 50 + index * 9, 200]);
/**
 * A filled control such as the selected tab, rows 2 to 5.
 */
const PILL = [2, 14, 60, 120];

const fill = (data: Uint8Array, row: number, from: number, to: number, value: number) => {
    for (let column = Math.max(0, from); column < Math.min(geometry.width, to); column += 1)
        data[row * geometry.width + column] = value;
};

/**
 * One frame of the close: the Session under a scrim of `scrim` opacity, and, unless `shift` is null, the drawer moved
 * `shift` columns right. A torn drawer (`isTorn`) lost its background and its pill's fill, so the Session shows through
 * it.
 */
function frame(shift: number | null, scrim: number, isTorn = false): GrayFrame {
    const data = new Uint8Array(geometry.width * geometry.height).fill(BACKGROUND);
    for (const [row, from, to, value] of SESSION_INK) {
        fill(data, row, from, to, value);
        fill(data, row + 1, from, to, value);
    }
    for (let index = 0; index < data.length; index += 1)
        data[index] = Math.round(data[index] * (1 - 0.5 * scrim));
    if (shift !== null) {
        const left = DRAWER_LEFT + shift;
        if (!isTorn) {
            for (let row = 0; row < geometry.height; row += 1)
                fill(data, row, left, geometry.width, BACKGROUND);
            const [top, from, to, value] = PILL;
            for (let row = top; row < top + 4; row += 1)
                fill(data, row, from + shift, to + shift, value);
        }
        for (const [row, from, to, value] of DRAWER_TEXT) {
            fill(data, row, from + shift, to + shift, value);
            fill(data, row + 1, from + shift, to + shift, value);
        }
    }
    return { data, time: 0 };
}

const close = (middle: GrayFrame[]): GrayFrame[] => [
    frame(0, 1),
    frame(0, 1),
    ...middle,
    frame(null, 0),
    frame(null, 0),
];

describe('drawer close analysis', () => {
    it('accepts a drawer that slides out as one opaque picture while its scrim fades', () => {
        const result = analyseDrawerClose(
            close([frame(10, 0.8), frame(25, 0.6), frame(45, 0.35), frame(65, 0.15)]),
            geometry,
        );
        expect(result.tornFrames).toBe(0);
        expect(result.movingFrames).toBeGreaterThanOrEqual(3);
        expect(result.scrimFadeFrames).toBeGreaterThanOrEqual(2);
    });

    it('counts frames where the drawer lost its backgrounds and the Session shows through', () => {
        const result = analyseDrawerClose(
            close([frame(10, 0, true), frame(25, 0, true), frame(45, 0, true)]),
            geometry,
        );
        expect(result.tornFrames).toBe(3);
    });

    it('does not judge the frame where only the scrim fade remains after the drawer left', () => {
        const result = analyseDrawerClose(
            close([frame(25, 0.6), frame(55, 0.3), frame(null, 0.15)]),
            geometry,
        );
        expect(result.tornFrames).toBe(0);
    });

    it('refuses a recording whose scrim does not visibly change', () => {
        expect(() => analyseDrawerClose([frame(0, 0), frame(null, 0)], geometry)).toThrow(
            /scrim strip barely changes/,
        );
    });
});

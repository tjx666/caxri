import { describe, expect, it } from 'vitest';

import type { GrayFrame } from './mobile-motion-analysis';
import { departuresFromFinalPicture, panelTransitions, redShare } from './mobile-motion-analysis';

const geometry = { height: 12, width: 60 };
const BACKGROUND = 40;

/**
 * Draws irregular text-like blocks so that no horizontal offset of one panel resembles another offset of itself.
 */
function panel(seed: number): number[][] {
    const blocks: number[][] = [];
    let state = seed;
    for (let row = 1; row < geometry.height - 1; row += 3) {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        const start = 4 + (state % 9);
        const length = 8 + ((state >> 8) % 30);
        blocks.push([row, start, Math.min(geometry.width - 4, start + length)]);
    }
    return blocks;
}

const draw = (blocks: number[][] | null, shift = 0, opacity = 1): Uint8Array => {
    const data = new Uint8Array(geometry.width * geometry.height).fill(BACKGROUND);
    const ink = Math.round(BACKGROUND + 180 * opacity);
    const drawn = blocks ?? [];
    for (const [row, start, end] of drawn) {
        const first = Math.max(0, start + shift);
        const last = Math.min(geometry.width, end + shift);
        for (let column = first; column < last; column += 1) {
            data[row * geometry.width + column] = ink;
            data[(row + 1) * geometry.width + column] = ink;
        }
    }
    return data;
};

/**
 * A recording where the first panel holds, the region blanks for `blankMs`, and the next panel enters through `steps`
 * of `[offset, opacity]` 33 ms apart before holding.
 */
function recording(steps: Array<[number, number]>, blankMs = 100): GrayFrame[] {
    const first = panel(7);
    const second = panel(19);
    const frames: GrayFrame[] = [
        { data: draw(first), time: 0 },
        { data: draw(first), time: 1000 },
        { data: draw(null), time: 1033 },
    ];
    let time = 1033 + blankMs;
    for (const [offset, opacity] of steps) {
        frames.push({ data: draw(second, offset, opacity), time });
        time += 33;
    }
    frames.push({ data: draw(second), time }, { data: draw(second), time: time + 1000 });
    return frames;
}

describe('panel entry analysis', () => {
    it('reads a panel that fades in from the right', () => {
        const [transition] = panelTransitions(
            recording([
                [12, 0.2],
                [8, 0.5],
                [4, 0.8],
                [1, 0.95],
            ]),
            geometry,
        );
        expect(transition.entry).toBe('from-right');
        expect(transition.displacements.slice(0, 3)).toEqual([12, 8, 4]);
    });

    it('reads a panel that fades in from the left even while its left edge is clipped', () => {
        const [transition] = panelTransitions(
            recording([
                [-12, 0.2],
                [-8, 0.5],
                [-4, 0.8],
            ]),
            geometry,
        );
        expect(transition.entry).toBe('from-left');
    });

    it('does not count a panel that appears after its entering animation as a slide', () => {
        const transitions = panelTransitions(recording([[-2, 1]], 150), geometry);
        expect(transitions.map(({ entry }) => entry)).toEqual(['in-place']);
    });

    it('keeps a long blank gap inside the transition instead of treating it as a settled panel', () => {
        const transitions = panelTransitions(
            recording(
                [
                    [10, 0.3],
                    [5, 0.7],
                ],
                600,
            ),
            geometry,
        );
        expect(transitions.map(({ entry }) => entry)).toEqual(['from-right']);
    });
});

describe('swipe action red share', () => {
    const area = { columns: 10, left: 800, rows: 4, scale: 4, top: 600 };
    /**
     * Dracula background with the danger red filling the left `redColumns` sample columns and one white glyph sample.
     */
    const frame = (redColumns: number): Uint8Array => {
        const pixels = new Uint8Array(area.columns * area.rows * 3);
        for (let index = 0; index < area.columns * area.rows; index += 1) {
            const isRed = index % area.columns < redColumns;
            pixels.set(isRed ? [255, 85, 85] : [40, 42, 54], index * 3);
        }
        pixels.set([248, 248, 242], 0);
        return pixels;
    };
    const region = { bottom: 616, left: 800, right: 840, top: 600 };

    it('reads a fully revealed action as nearly all red', () => {
        expect(redShare(frame(10), area, region)).toBeCloseTo(39 / 40);
    });

    it('reads a half revealed action as half red', () => {
        expect(redShare(frame(5), area, region)).toBeCloseTo(19 / 40);
    });

    it('only counts samples inside the region', () => {
        expect(redShare(frame(5), area, { ...region, left: 820 })).toBe(0);
    });
});

describe('departures from the final picture', () => {
    const settled = panel(7);
    const recording = (shifts: Array<number | null>): GrayFrame[] =>
        shifts.map((shift, index) => ({
            data: shift === null ? draw(null) : draw(settled, shift),
            time: index * 16,
        }));

    it('counts none for a region that stays blank until it shows its final picture', () => {
        expect(departuresFromFinalPicture(recording([null, null, 0, 0, 0]))).toEqual({
            departures: 0,
            settledAt: 32,
        });
    });

    it('counts every frame that moves away after the final picture first appeared', () => {
        expect(departuresFromFinalPicture(recording([null, 0, 6, 0, -4, 0])).departures).toBe(2);
    });
});

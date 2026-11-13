import type { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { renderMenuBarGlyph } from '../menu-bar-glyph';

function alphaAt(bitmap: Buffer, size: number, x: number, y: number): number {
    return bitmap[(Math.floor(y * size) * size + Math.floor(x * size)) * 4 + 3] ?? 0;
}

describe('renderMenuBarGlyph', () => {
    it('draws an alpha-only template bitmap of the requested size', () => {
        const size = 36;
        const bitmap = renderMenuBarGlyph(size);
        expect(bitmap).toHaveLength(size * size * 4);
        for (let index = 0; index < bitmap.length; index += 4)
            expect([bitmap[index], bitmap[index + 1], bitmap[index + 2]]).toEqual([0, 0, 0]);
    });

    it('fills the ring and the cursor but leaves the opening and the corners clear', () => {
        const size = 36;
        const bitmap = renderMenuBarGlyph(size);
        expect(alphaAt(bitmap, size, 0.13, 0.5)).toBe(255);
        expect(alphaAt(bitmap, size, 0.62, 0.5)).toBe(255);
        expect(alphaAt(bitmap, size, 0.9, 0.5)).toBe(0);
        expect(alphaAt(bitmap, size, 0.02, 0.02)).toBe(0);
    });
});

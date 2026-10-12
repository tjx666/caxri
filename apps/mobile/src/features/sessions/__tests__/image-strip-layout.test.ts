import { describe, expect, it } from 'vitest';

import type { StripRect } from '../image-strip-layout';
import {
    imageStripCellRect,
    imageStripRemoveTargetRect,
    imageStripThumbnailRect,
} from '../image-strip-layout';

const isOverlapping = (a: StripRect, b: StripRect): boolean =>
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const isContaining = (outer: StripRect, inner: StripRect): boolean =>
    inner.left >= outer.left &&
    inner.right <= outer.right &&
    inner.top >= outer.top &&
    inner.bottom <= outer.bottom;

describe('composer image strip layout', () => {
    it('gives each remove button a 44dp target over its own thumbnail corner', () => {
        const target = imageStripRemoveTargetRect(0);
        expect(target.right - target.left).toBeGreaterThanOrEqual(44);
        expect(target.bottom - target.top).toBeGreaterThanOrEqual(44);
        expect(isOverlapping(target, imageStripThumbnailRect(0))).toBe(true);
    });

    it('keeps the target inside its cell, where Android delivers its touches', () => {
        expect(isContaining(imageStripCellRect(3), imageStripRemoveTargetRect(3))).toBe(true);
        expect(isContaining(imageStripCellRect(3), imageStripThumbnailRect(3))).toBe(true);
    });

    it('never covers the next thumbnail or its target', () => {
        const target = imageStripRemoveTargetRect(0);
        expect(isOverlapping(target, imageStripThumbnailRect(1))).toBe(false);
        expect(isOverlapping(target, imageStripRemoveTargetRect(1))).toBe(false);
        expect(imageStripThumbnailRect(1).left - imageStripThumbnailRect(0).right).toBeGreaterThan(
            16,
        );
    });
});

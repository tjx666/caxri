import { Buffer } from 'node:buffer';

/**
 * The menu bar glyph's point size; macOS status items are 22pt tall and center an 18pt template image.
 */
export const MENU_BAR_GLYPH_POINTS = 18;

/**
 * The Caxri mark in unit coordinates (y down): a "C" ring opening to the right with a text cursor inside it.
 */
const RING_CENTER = 0.5;
const RING_OUTER = 0.44;
const RING_INNER = 0.3;
/**
 * Half the angle the ring leaves open on the right, in radians.
 */
const RING_GAP = (40 * Math.PI) / 180;
const RING_MID = (RING_OUTER + RING_INNER) / 2;
const RING_CAP = (RING_OUTER - RING_INNER) / 2;
const CURSOR_X = 0.62;
const CURSOR_TOP = 0.36;
const CURSOR_BOTTOM = 0.64;
const CURSOR_HALF_WIDTH = 0.055;

const SUBSAMPLES = 4;

function isInsideRing(x: number, y: number): boolean {
    const dx = x - RING_CENTER;
    const dy = y - RING_CENTER;
    const distance = Math.hypot(dx, dy);
    if (
        distance >= RING_INNER &&
        distance <= RING_OUTER &&
        Math.abs(Math.atan2(dy, dx)) >= RING_GAP
    )
        return true;
    // Round caps at both ends of the opening.
    for (const sign of [-1, 1]) {
        const capX = RING_CENTER + RING_MID * Math.cos(sign * RING_GAP);
        const capY = RING_CENTER + RING_MID * Math.sin(sign * RING_GAP);
        if (Math.hypot(x - capX, y - capY) <= RING_CAP) return true;
    }
    return false;
}

function isInsideCursor(x: number, y: number): boolean {
    const clampedY = Math.min(Math.max(y, CURSOR_TOP), CURSOR_BOTTOM);
    return Math.hypot(x - CURSOR_X, y - clampedY) <= CURSOR_HALF_WIDTH;
}

/**
 * Rasterizes the mark into a square 32-bit bitmap, `size` pixels a side, for a macOS template image: every color
 * channel stays 0 and alpha carries the antialiased coverage, so the channel order Electron expects does not matter and
 * macOS tints it for the menu bar's appearance. Drawn in code so the menu bar needs no binary asset at each scale.
 */
export function renderMenuBarGlyph(size: number): Buffer {
    const bitmap = Buffer.alloc(size * size * 4);
    const step = 1 / (size * SUBSAMPLES);
    for (let row = 0; row < size; row += 1) {
        for (let column = 0; column < size; column += 1) {
            let covered = 0;
            for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
                for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
                    const x = (column * SUBSAMPLES + sx + 0.5) * step;
                    const y = (row * SUBSAMPLES + sy + 0.5) * step;
                    if (isInsideRing(x, y) || isInsideCursor(x, y)) covered += 1;
                }
            }
            bitmap[(row * size + column) * 4 + 3] = Math.round(
                (covered / (SUBSAMPLES * SUBSAMPLES)) * 255,
            );
        }
    }
    return bitmap;
}

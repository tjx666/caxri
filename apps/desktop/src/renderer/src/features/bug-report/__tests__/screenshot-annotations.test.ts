import { describe, expect, it } from 'vitest';

import type { AnnotationRenderingContext, ScreenshotAnnotation } from '../screenshot-annotations';
import {
    ANNOTATION_BADGE_RADIUS,
    ANNOTATION_COLOR,
    ANNOTATION_STROKE_WIDTH,
    annotationBadgePoint,
    arrowHeadPoints,
    drawAnnotations,
    formatAnnotationLines,
    isNegligibleDrag,
    normalizeBox,
} from '../screenshot-annotations';

function box(overrides: Partial<ScreenshotAnnotation> = {}): ScreenshotAnnotation {
    return {
        id: 'box-1',
        kind: 'box',
        note: '',
        x1: 650,
        y1: 250,
        x2: 815,
        y2: 400,
        ...overrides,
    };
}

function arrow(overrides: Partial<ScreenshotAnnotation> = {}): ScreenshotAnnotation {
    return {
        id: 'arrow-1',
        kind: 'arrow',
        note: '',
        x1: 300,
        y1: 540,
        x2: 575,
        y2: 660,
        ...overrides,
    };
}

/**
 * Records the drawing calls in order so the rasterizer can be asserted without a canvas: the Renderer test project runs
 * in a `node` environment.
 */
function recordingContext(): AnnotationRenderingContext & { calls: string[] } {
    const calls: string[] = [];
    /**
     * `fillStyle`/`strokeStyle` are gradients or patterns as far as the DOM types are concerned, so the recorded values
     * are kept here as plain strings. `drawAnnotations` only ever assigns CSS color strings; anything else would be a
     * regression worth failing on, which is what the empty fallback produces.
     */
    const style = { fill: '', stroke: '' };
    return {
        calls,
        font: '',
        lineWidth: 0,
        textAlign: 'start',
        textBaseline: 'alphabetic',
        get fillStyle() {
            return style.fill;
        },
        set fillStyle(value) {
            style.fill = typeof value === 'string' ? value : '';
        },
        get strokeStyle() {
            return style.stroke;
        },
        set strokeStyle(value) {
            style.stroke = typeof value === 'string' ? value : '';
        },
        arc(x, y, radius) {
            calls.push(`arc ${x} ${y} ${Math.round(radius)} ${style.fill}`);
        },
        beginPath() {
            calls.push('beginPath');
        },
        fill() {
            calls.push(`fill ${style.fill}`);
        },
        fillText(text, x, y) {
            calls.push(`fillText ${text} ${Math.round(x)} ${Math.round(y)} ${style.fill}`);
        },
        lineTo(x, y) {
            calls.push(`lineTo ${Math.round(x)} ${Math.round(y)}`);
        },
        moveTo(x, y) {
            calls.push(`moveTo ${Math.round(x)} ${Math.round(y)}`);
        },
        stroke() {
            calls.push(`stroke ${style.stroke}`);
        },
        strokeRect(x, y, width, height) {
            calls.push(`strokeRect ${x} ${y} ${width} ${height} ${style.stroke}`);
        },
    };
}

describe('annotation geometry', () => {
    it('normalizes a drag made in any direction into the same rectangle', () => {
        expect(normalizeBox({ x1: 815, y1: 400, x2: 650, y2: 250 })).toEqual({
            height: 150,
            width: 165,
            x: 650,
            y: 250,
        });
        expect(normalizeBox({ x1: 650, y1: 250, x2: 815, y2: 400 })).toEqual({
            height: 150,
            width: 165,
            x: 650,
            y: 250,
        });
    });

    it('discards an accidental click but keeps a deliberate thin arrow', () => {
        expect(isNegligibleDrag({ kind: 'box', x1: 10, y1: 10, x2: 12, y2: 90 })).toBe(true);
        expect(isNegligibleDrag({ kind: 'box', x1: 10, y1: 10, x2: 90, y2: 90 })).toBe(false);
        expect(isNegligibleDrag({ kind: 'arrow', x1: 10, y1: 10, x2: 12, y2: 11 })).toBe(true);
        expect(isNegligibleDrag({ kind: 'arrow', x1: 10, y1: 10, x2: 120, y2: 10 })).toBe(false);
    });

    it('anchors the badge at the box corner and at the arrow tail', () => {
        expect(annotationBadgePoint(box({ x1: 815, y1: 400, x2: 650, y2: 250 }))).toEqual({
            x: 650,
            y: 250,
        });
        expect(annotationBadgePoint(arrow())).toEqual({ x: 300, y: 540 });
    });

    it('places both arrow barbs behind the tip and scales them with the display scale', () => {
        const [firstBarb, secondBarb] = arrowHeadPoints(
            { x1: 0, y1: 0, x2: 100, y2: 0 },
            /* scale */ 2,
        );

        expect(firstBarb.x).toBeLessThan(100);
        expect(secondBarb.x).toBeLessThan(100);
        // The barbs straddle the shaft, one on each side.
        expect(firstBarb.y).toBeGreaterThan(0);
        expect(secondBarb.y).toBeLessThan(0);
        // A doubled scale doubles the head's distance from the tip.
        const [singleScaleBarb] = arrowHeadPoints({ x1: 0, y1: 0, x2: 100, y2: 0 }, 1);
        expect(100 - firstBarb.x).toBeCloseTo(2 * (100 - singleScaleBarb.x));
    });
});

describe('annotation rasterization', () => {
    it('strokes each shape and its numbered badge at the requested scale', () => {
        const context = recordingContext();

        drawAnnotations(context, [box(), arrow()], 2);

        expect(context.lineWidth).toBe(ANNOTATION_STROKE_WIDTH * 2);
        expect(context.calls).toContain(`strokeRect 650 250 165 150 ${ANNOTATION_COLOR}`);
        expect(context.calls).toContain(
            `arc 650 250 ${ANNOTATION_BADGE_RADIUS * 2} ${ANNOTATION_COLOR}`,
        );
        expect(context.calls).toContain('fillText 1 650 250 #ffffff');
        expect(context.calls).toContain('moveTo 300 540');
        expect(context.calls).toContain('lineTo 575 660');
        expect(context.calls).toContain('fillText 2 300 540 #ffffff');
        expect(context.calls).toContain(`stroke ${ANNOTATION_COLOR}`);
    });

    it('draws nothing for an empty annotation list', () => {
        const context = recordingContext();

        drawAnnotations(context, [], 1);

        expect(context.calls).toEqual([]);
    });
});

describe('annotation report lines', () => {
    it('numbers each annotation, rounds pixels, and marks an empty note', () => {
        expect(
            formatAnnotationLines([
                box({ note: 'This button is misaligned', x1: 650.4, y1: 249.7 }),
                arrow(),
            ]),
        ).toEqual([
            '  1. [box x=650 y=250 w=165 h=150] This button is misaligned',
            '  2. [arrow from (300,540) to (575,660)] (no note)',
        ]);
    });

    it('routes notes through the injected sanitizer and keeps every entry on one line', () => {
        expect(
            formatAnnotationLines([box({ note: 'token=private-value\nsecond line' })], (note) =>
                note.replace('private-value', '[REDACTED]'),
            ),
        ).toEqual(['  1. [box x=650 y=250 w=165 h=150] token=[REDACTED] second line']);
    });
});

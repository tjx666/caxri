import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    anchoredScrollOffset,
    clampPreviewScale,
    fitPreviewScale,
    MAX_PREVIEW_SCALE,
    MIN_PREVIEW_SCALE,
    pinchScaleFactor,
    previewZoomLabel,
    stepPreviewScale,
} from '../preview-zoom';

describe('fitPreviewScale', () => {
    it('shrinks a large picture to the viewport less its padding on the tighter axis', () => {
        expect(
            fitPreviewScale({ width: 2400, height: 1600 }, { width: 1248, height: 848 }, 24),
        ).toBe(0.5);
    });

    it('never enlarges a small picture past its natural size', () => {
        expect(fitPreviewScale({ width: 16, height: 16 }, { width: 800, height: 600 }, 24)).toBe(1);
    });

    it('treats an unmeasured picture as natural size', () => {
        expect(fitPreviewScale({ width: 0, height: 0 }, { width: 800, height: 600 }, 24)).toBe(1);
    });

    it('still fits the whole picture into a pane narrower than the step range allows', () => {
        expect(
            fitPreviewScale({ width: 2400, height: 1600 }, { width: 168, height: 800 }, 24),
        ).toBe(0.05);
    });
});

describe('stepPreviewScale', () => {
    it('steps between the fixed menu choices', () => {
        expect(stepPreviewScale(1, 'in')).toBe(1.5);
        expect(stepPreviewScale(1, 'out')).toBe(0.75);
        expect(stepPreviewScale(0.62, 'in')).toBe(0.75);
        expect(stepPreviewScale(0.62, 'out')).toBe(0.5);
    });

    it('does not step to the stop a pinch left it a hair away from', () => {
        expect(stepPreviewScale(1.4999, 'in')).toBe(2);
    });

    it('steps by 25% past the last choice and stops at the scale range', () => {
        expect(stepPreviewScale(3, 'in')).toBe(3.75);
        expect(stepPreviewScale(0.5, 'out')).toBe(0.4);
        expect(stepPreviewScale(MAX_PREVIEW_SCALE, 'in')).toBe(MAX_PREVIEW_SCALE);
        expect(stepPreviewScale(MIN_PREVIEW_SCALE, 'out')).toBe(MIN_PREVIEW_SCALE);
        expect(stepPreviewScale(0.05, 'out')).toBe(0.05);
        expect(stepPreviewScale(0.05, 'in')).toBe(0.5);
    });
});

describe('pinchScaleFactor', () => {
    it('zooms in for a negative delta, and pinching back the same amount undoes it', () => {
        expect(pinchScaleFactor(-10)).toBeGreaterThan(1);
        expect(pinchScaleFactor(10) * pinchScaleFactor(-10)).toBeCloseTo(1);
        expect(pinchScaleFactor(0)).toBe(1);
    });
});

describe('clampPreviewScale', () => {
    it('keeps a scale inside the range', () => {
        expect(clampPreviewScale(100)).toBe(MAX_PREVIEW_SCALE);
        expect(clampPreviewScale(0)).toBe(MIN_PREVIEW_SCALE);
        expect(clampPreviewScale(2)).toBe(2);
    });
});

describe('anchoredScrollOffset', () => {
    const base = { viewport: 500, picture: 1000, padding: 20 };

    it('keeps the picture point under the pointer in place when zooming in', () => {
        // At scale 1 the picture starts at the padding; the pointer at 100 with scroll 0 is picture point 80.
        const scroll = anchoredScrollOffset({
            ...base,
            scroll: 0,
            pointer: 100,
            scale: 1,
            nextScale: 2,
        });
        // Point 80 lands at 20 + 160 = 180 in the content, so it stays at 100 in the viewport with scroll 80.
        expect(scroll).toBe(80);
    });

    it('accounts for the centering of a picture smaller than the viewport', () => {
        // At 0.25 the 250px picture is centered at 125; the pointer at 250 is its middle, point 500.
        const scroll = anchoredScrollOffset({
            ...base,
            scroll: 0,
            pointer: 250,
            scale: 0.25,
            nextScale: 1,
        });
        // At 1 the point sits at 20 + 500 = 520 in the content; under a pointer at 250 the scroll is 270.
        expect(scroll).toBe(270);
    });

    it('clamps to the scroll range', () => {
        expect(
            // The pointer over the leading padding would anchor a point before the picture's edge.
            anchoredScrollOffset({ ...base, scroll: 0, pointer: 0, scale: 1, nextScale: 2 }),
        ).toBe(0);
        expect(
            anchoredScrollOffset({ ...base, scroll: 520, pointer: 500, scale: 1, nextScale: 0.25 }),
        ).toBe(0);
    });
});

describe('previewZoomLabel', () => {
    it('names Fit and shows a fixed scale as a percentage', () => {
        expect(previewZoomLabel('fit', translate)).toBe('Fit');
        expect(previewZoomLabel(1.5, translate)).toBe('150%');
    });
});

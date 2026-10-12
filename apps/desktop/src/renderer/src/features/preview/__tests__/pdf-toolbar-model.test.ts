import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    clampPdfPageNumber,
    describePdfView,
    parsePdfPageInput,
    PDF_ZOOM_CHOICES,
    pdfZoomChoiceLabel,
} from '../pdf-toolbar-model';

describe('PDF page field', () => {
    it('clamps a typed page to the document', () => {
        expect(parsePdfPageInput('4', 10, 1)).toBe(4);
        expect(parsePdfPageInput('0', 10, 3)).toBe(1);
        expect(parsePdfPageInput('99', 10, 3)).toBe(10);
        expect(parsePdfPageInput(' 2.6 ', 10, 3)).toBe(3);
    });

    it('keeps the current page for an empty or non-numeric entry', () => {
        expect(parsePdfPageInput('', 10, 7)).toBe(7);
        expect(parsePdfPageInput('abc', 10, 7)).toBe(7);
        expect(clampPdfPageNumber(NaN, 10, 5)).toBe(5);
    });
});

describe('PDF zoom menu', () => {
    it('offers the two fits before the fixed scales', () => {
        const labels = PDF_ZOOM_CHOICES.map((choice) => pdfZoomChoiceLabel(choice, translate));
        expect(labels.slice(0, 3)).toEqual(['Fit Width', 'Fit Page', '50%']);
        expect(pdfZoomChoiceLabel(1, translate)).toBe('100%');
    });

    it('announces the page and zoom after an explicit change', () => {
        expect(describePdfView(3, 12, 1.25)).toBe('Page 3 of 12, 125%');
    });
});

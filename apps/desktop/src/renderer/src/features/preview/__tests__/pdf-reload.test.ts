import { describe, expect, it } from 'vitest';

import type { PdfSettledRead } from '../pdf-reload';
import { pdfReadFailureAction, shownPdfRead } from '../pdf-reload';

describe('shownPdfRead', () => {
    const settled: PdfSettledRead<string> = { source: 'report', request: 1, state: 'page 3' };

    it('loads before the first read settles', () => {
        expect(shownPdfRead(undefined, { source: 'report', request: 0, cause: 'open' })).toBe(
            undefined,
        );
    });

    it('shows the read that answers the current request', () => {
        expect(shownPdfRead(settled, { source: 'report', request: 1, cause: 'open' })).toBe(
            'page 3',
        );
    });

    it('keeps the previous document on screen while a disk reload or its confirmation reads', () => {
        expect(shownPdfRead(settled, { source: 'report', request: 2, cause: 'disk' })).toBe(
            'page 3',
        );
        expect(shownPdfRead(settled, { source: 'report', request: 3, cause: 'confirm' })).toBe(
            'page 3',
        );
    });

    it('shows the loading state for Retry', () => {
        expect(shownPdfRead(settled, { source: 'report', request: 2, cause: 'open' })).toBe(
            undefined,
        );
    });

    it('never shows another file in place of this one', () => {
        expect(shownPdfRead(settled, { source: 'manual', request: 1, cause: 'open' })).toBe(
            undefined,
        );
        expect(shownPdfRead(settled, { source: 'manual', request: 2, cause: 'disk' })).toBe(
            undefined,
        );
    });
});

describe('pdfReadFailureAction', () => {
    it('confirms a failed disk reload once before showing the failure', () => {
        expect(pdfReadFailureAction('disk')).toBe('confirm');
        expect(pdfReadFailureAction('confirm')).toBe('show');
    });

    it('shows a failed first read or Retry at once', () => {
        expect(pdfReadFailureAction('open')).toBe('show');
    });
});

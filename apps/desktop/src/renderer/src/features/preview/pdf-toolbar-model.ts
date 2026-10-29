/**
 * The zoom choices the toolbar's zoom menu offers: the two fits, then fixed scales. A fit is a pdf.js scale preset that
 * keeps following the pane as it resizes; a number is a fixed scale, 1 being the page's natural size.
 */
import type { Translate } from '../../i18n';

export type PdfZoomChoice = 'page-fit' | 'page-width' | number;

export const PDF_ZOOM_CHOICES: readonly PdfZoomChoice[] = [
    'page-width',
    'page-fit',
    0.5,
    0.75,
    1,
    1.25,
    1.5,
    2,
    3,
];

/**
 * The menu text for a zoom choice: a fit by name, a fixed scale as its percentage.
 */
export function pdfZoomChoiceLabel(choice: PdfZoomChoice, t: Translate): string {
    if (choice === 'page-width') return t('preview.pdf.fitWidth');
    if (choice === 'page-fit') return t('preview.pdf.fitPage');
    return `${Math.round(choice * 100)}%`;
}

/**
 * Clamps a page number to the document. A value that is not a number keeps the current page, so clearing the page field
 * and pressing Enter goes nowhere instead of jumping to page 1.
 */
export function clampPdfPageNumber(value: number, pageCount: number, current: number): number {
    if (!Number.isFinite(value)) return current;
    return Math.min(Math.max(1, Math.round(value)), Math.max(1, pageCount));
}

/**
 * The page the toolbar's previous (`-1`) or next (`1`) button goes to, or `undefined` at the document's edge so the
 * button can disable instead of re-announcing the page the reader is already on.
 */
export function adjacentPdfPage(
    current: number,
    step: -1 | 1,
    pageCount: number,
): number | undefined {
    const target = clampPdfPageNumber(current + step, pageCount, current);
    return target === current ? undefined : target;
}

/**
 * Reads what the user typed into the page field. An empty or non-numeric entry keeps the current page.
 */
export function parsePdfPageInput(text: string, pageCount: number, current: number): number {
    const trimmed = text.trim();
    return clampPdfPageNumber(trimmed === '' ? NaN : Number(trimmed), pageCount, current);
}

/**
 * The sentence the toolbar's live region announces after an explicit page jump or zoom change. Scrolling past a page
 * boundary updates the visible page number silently: announcing every boundary while a reader scrolls is noise.
 */
export function describePdfView(
    pageNumber: number,
    pageCount: number,
    scale: number,
    t: Translate,
): string {
    return t('preview.pdf.viewAnnouncement', {
        page: pageNumber,
        count: pageCount,
        percent: Math.round(scale * 100),
    });
}

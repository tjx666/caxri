/**
 * The zoom choices the toolbar's zoom menu offers: the two fits, then fixed scales. A fit is a pdf.js scale preset that
 * keeps following the pane as it resizes; a number is a fixed scale, 1 being the page's natural size.
 */
export type PdfZoomChoice = 'page-fit' | 'page-width' | number;

export const PDF_ZOOM_CHOICES: ReadonlyArray<{ choice: PdfZoomChoice; label: string }> = [
    { choice: 'page-width', label: 'Fit Width' },
    { choice: 'page-fit', label: 'Fit Page' },
    ...[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map((scale) => ({
        choice: scale,
        label: `${Math.round(scale * 100)}%`,
    })),
];

/**
 * Clamps a page number to the document. A value that is not a number keeps the current page, so clearing the page field
 * and pressing Enter goes nowhere instead of jumping to page 1.
 */
export function clampPdfPageNumber(value: number, pageCount: number, current: number): number {
    if (!Number.isFinite(value)) return current;
    return Math.min(Math.max(1, Math.round(value)), Math.max(1, pageCount));
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
export function describePdfView(pageNumber: number, pageCount: number, scale: number): string {
    return `Page ${pageNumber} of ${pageCount}, ${Math.round(scale * 100)}%`;
}

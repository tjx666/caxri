/**
 * Find in a PDF preview: the request shape pdf.js's find controller reads, the count the find bar shows, and the chord
 * that opens it. The viewer side lives in `pdf-document.ts` and the React state in `use-pdf-find.ts`.
 */
import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * What the find controller last reported. `current` is 1-based and is 0 only while `total` is 0.
 */
export interface PdfFindResult {
    current: number;
    total: number;
    /**
     * The controller is still extracting page text or waiting out its typing delay, so a zero total is not yet "No
     * results".
     */
    isPending: boolean;
}

export const EMPTY_PDF_FIND_RESULT: PdfFindResult = { current: 0, total: 0, isPending: false };

/**
 * How a find request moves through the matches: `query` searches from the visible page after pdf.js's typing delay,
 * `next` and `previous` step from the current match, and `refresh` repaints every match without moving (reopening the
 * bar on the query it kept).
 */
export type PdfFindStep = 'next' | 'previous' | 'query' | 'refresh';

/**
 * The `find` event pdf.js's `PDFFindController` listens for. Matching is case- and diacritic-insensitive and every
 * match is highlighted, like the Terminal and Chat find bars.
 */
export interface PdfFindEvent {
    source: null;
    type: '' | 'again' | 'highlightallchange';
    query: string;
    caseSensitive: false;
    entireWord: false;
    highlightAll: true;
    findPrevious: boolean;
    matchDiacritics: false;
}

export function pdfFindEvent(query: string, step: PdfFindStep): PdfFindEvent {
    return {
        source: null,
        type: step === 'query' ? '' : step === 'refresh' ? 'highlightallchange' : 'again',
        query,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: step === 'previous',
        matchDiacritics: false,
    };
}

/**
 * The count beside the query: empty before a query is typed and while the first results are still coming in, then
 * `3/12`, or "No results" once the whole document was searched.
 */
export function pdfFindCountLabel(
    query: string,
    result: PdfFindResult,
    t: Translate = translate,
): string {
    if (!query) return '';
    if (result.total === 0) return result.isPending ? '' : t('preview.pdf.findNoResults');
    return `${result.current}/${result.total}`;
}

/**
 * Whether the count reads as a miss, which the find bar shows in the danger tone.
 */
export function isPdfFindMiss(query: string, result: PdfFindResult): boolean {
    return query !== '' && !result.isPending && result.total === 0;
}

/**
 * `Cmd+F` inside the preview. The app-wide `terminal.find` binding only acts when a Terminal is the active tab and
 * otherwise lets the chord through untouched, the same way Monaco receives it for its own Find widget.
 */
export function isPdfFindShortcut(event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
}): boolean {
    return (
        event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'f'
    );
}

/**
 * How long a reload that a disk change caused waits before it reads the file a second time, when its first read failed.
 * See {@link pdfReadFailureAction}.
 */
export const PDF_FAILURE_CONFIRM_MS = 1000;

/**
 * Why a PDF preview reads its file. `open` is the tab's first read and the user's Retry; `disk` is a watcher change to
 * the file; `confirm` is the second read of a `disk` reload whose first read failed.
 */
export type PdfReadCause = 'confirm' | 'disk' | 'open';

/**
 * A finished read, tagged with the file it read (`source`) and the request it answered.
 */
export interface PdfSettledRead<State> {
    source: string;
    request: number;
    state: State;
}

/**
 * What the preview shows while `current` is the latest request, or `undefined` for the loading state.
 *
 * A read that answers the current request is shown as is. While a reload caused by a disk change is in flight, the last
 * result for the same file stays on screen, so the reader keeps their page instead of watching the view blank out and
 * rebuild for a file that is most likely still readable. Retry and a different file show the loading state, as the user
 * asked for a fresh read or a different document.
 */
export function shownPdfRead<State>(
    settled: PdfSettledRead<State> | undefined,
    current: { source: string; request: number; cause: PdfReadCause },
): State | undefined {
    if (!settled || settled.source !== current.source) return undefined;
    if (settled.request === current.request) return settled.state;
    return current.cause === 'open' ? undefined : settled.state;
}

/**
 * What a failed read does: `show` replaces the view with the failure, `confirm` keeps the current view and reads once
 * more after {@link PDF_FAILURE_CONFIRM_MS}.
 *
 * A read caused by a disk change most often caught the writer midway: a half-written file parses as an invalid PDF, and
 * a delete-then-rename replacement briefly reads as missing. Confirming once keeps that window from flashing a failure,
 * while a file that really stays broken or deleted still shows its failure, with Retry, a second later.
 */
export function pdfReadFailureAction(cause: PdfReadCause): 'confirm' | 'show' {
    return cause === 'disk' ? 'confirm' : 'show';
}

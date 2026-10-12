import { useEffect, useState } from 'react';

import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

import { loadPdfDocument } from './pdf-document';
import type { PdfFailure } from './pdf-failure';
import { describePdfFailure } from './pdf-failure';
import { readAssetBytes } from './preview-asset-client';
import { usePreviewSourceRevision } from './use-preview-source-revision';

export type PdfDocumentState =
    | { status: 'failed'; failure: PdfFailure }
    | { status: 'loading' }
    | { status: 'ready'; document: PDFDocumentProxy };

/**
 * Reads a PDF through `files.readAsset` and parses it, once per path, per retry, and per rewrite of the file on disk.
 *
 * The document is owned by this hook: unmounting, switching paths, or retrying destroys the loading task, which ends
 * the document and releases its pages in the shared worker. A read that is still in flight is aborted instead.
 */
export function usePdfDocument(
    sessionId: string,
    workbenchProjectId: string | undefined,
    path: string,
): { state: PdfDocumentState; retry: () => void } {
    const [attempt, setAttempt] = useState(0);
    /**
     * A settled result is tagged with the read it answers, so a new path or a retry reads as loading on the very render
     * that requested it, without resetting state from inside the effect.
     */
    const revision = usePreviewSourceRevision(workbenchProjectId, path);
    const requestKey = `${sessionId}\0${path}\0${attempt}\0${revision}`;
    const [result, setResult] = useState<{ key: string; state: PdfDocumentState }>();

    useEffect(() => {
        const controller = new AbortController();
        let task: PDFDocumentLoadingTask | undefined;
        const settle = (state: PdfDocumentState): void => {
            if (!controller.signal.aborted) setResult({ key: requestKey, state });
        };
        const open = async (): Promise<void> => {
            try {
                const bytes = await readAssetBytes(sessionId, path, controller.signal);
                if (controller.signal.aborted) return;
                task = loadPdfDocument(bytes);
                const document = await task.promise;
                settle({ status: 'ready', document });
            } catch (error) {
                settle({ status: 'failed', failure: describePdfFailure(error) });
            }
        };
        // eslint-disable-next-line no-void -- every failure is caught above and becomes the failed state
        void open();
        return () => {
            controller.abort();
            // eslint-disable-next-line no-void -- teardown has nothing to report; a destroyed task cannot fail usefully
            void task?.destroy();
        };
    }, [path, requestKey, sessionId]);

    return {
        state: result?.key === requestKey ? result.state : { status: 'loading' },
        retry: () => setAttempt((value) => value + 1),
    };
}

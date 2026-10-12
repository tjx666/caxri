import { useEffect, useState } from 'react';

import { delay } from 'es-toolkit';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';

import { loadPdfDocument } from '../pdf-document';
import type { PdfFailure } from '../pdf-failure';
import { describePdfFailure } from '../pdf-failure';
import type { PdfReadCause, PdfSettledRead } from '../pdf-reload';
import { PDF_FAILURE_CONFIRM_MS, pdfReadFailureAction, shownPdfRead } from '../pdf-reload';
import { readAssetBytes } from '../preview-asset-client';
import { usePreviewSourceRevision } from './use-preview-source-revision';

export type PdfDocumentState =
    | { status: 'failed'; failure: PdfFailure }
    | { status: 'loading' }
    | { status: 'ready'; document: PDFDocumentProxy };

interface PdfReadRequest {
    /**
     * Unique per read within this hook, so a settled result answers exactly the request that started it.
     */
    id: number;
    cause: PdfReadCause;
}

/**
 * /** A settled read also carries the loading task of a document it parsed, which owns that document.
 */
type SettledRead = PdfSettledRead<PdfDocumentState> & { task?: PDFDocumentLoadingTask };

/**
 * Reads a PDF through `files.readAsset` and parses it when the tab opens, on Retry, and again whenever the file is
 * rewritten on disk (`usePreviewSourceRevision`). A reload the disk caused keeps the previous document on screen until
 * the new one parses (see `shownPdfRead`), and confirms a failed read once before showing it (see
 * `pdfReadFailureAction`).
 *
 * The hook owns every document it parses. The settled one lives until a later read settles or the view unmounts, which
 * is what lets a reload keep showing it; a read still in flight when it is superseded is aborted, and a document it
 * parsed is destroyed, which releases its pages in the shared worker.
 */
export function usePdfDocument(
    sessionId: string,
    workbenchProjectId: string | undefined,
    path: string,
): { state: PdfDocumentState; retry: () => void } {
    const source = `${sessionId}\0${path}`;
    const [request, setRequest] = useState<PdfReadRequest>({ id: 0, cause: 'open' });
    const [settled, setSettled] = useState<SettledRead>();
    // A rewrite on disk starts a `disk` read. Reset during render, so the read starts in the commit that saw the change.
    const revision = usePreviewSourceRevision(workbenchProjectId, path);
    const [readRevision, setReadRevision] = useState(revision);
    if (readRevision !== revision) {
        setReadRevision(revision);
        setRequest((current) => ({ id: current.id + 1, cause: 'disk' }));
    }

    useEffect(() => {
        const controller = new AbortController();
        let task: PDFDocumentLoadingTask | undefined;
        let isAdopted = false;
        /**
         * Read through a call rather than the property: TypeScript keeps a property narrowed across `await`, so a
         * second inline check after the parse would read as dead code, while cleanup can abort the request during
         * either wait.
         */
        const isSuperseded = (): boolean => controller.signal.aborted;
        /**
         * Every state update after an await goes through these two, which drop the result once cleanup superseded this
         * read, so a late read can never overwrite the one that replaced it.
         */
        const settle = (state: PdfDocumentState, adoptedTask?: PDFDocumentLoadingTask): void => {
            if (isSuperseded()) return;
            isAdopted = adoptedTask !== undefined;
            setSettled({ source, request: request.id, state, task: adoptedTask });
        };
        const requestConfirmation = (): void => {
            if (isSuperseded()) return;
            // A newer change or a Retry already replaced this request; its own read decides.
            setRequest((current) =>
                current === request ? { id: current.id + 1, cause: 'confirm' } : current,
            );
        };
        const open = async (): Promise<void> => {
            try {
                const bytes = await readAssetBytes(sessionId, path, controller.signal);
                if (isSuperseded()) return;
                task = loadPdfDocument(bytes);
                const document = await task.promise;
                settle({ status: 'ready', document }, task);
            } catch (error) {
                if (pdfReadFailureAction(request.cause) !== 'confirm') {
                    settle({ status: 'failed', failure: describePdfFailure(error) });
                    return;
                }
                try {
                    await delay(PDF_FAILURE_CONFIRM_MS, { signal: controller.signal });
                } catch {
                    // Cleanup aborted the wait: a superseded read never asks again.
                    return;
                }
                requestConfirmation();
            }
        };
        // eslint-disable-next-line no-void -- every failure is caught above and becomes the failed state or a confirmation
        void open();
        return () => {
            controller.abort();
            // eslint-disable-next-line no-void -- teardown has nothing to report; a destroyed task cannot fail usefully
            if (!isAdopted) void task?.destroy();
        };
    }, [path, request, sessionId, source]);

    /**
     * The settled document is released when a later read replaces it (a reload, a failure, another file) or when the
     * view unmounts. A reload's new document mounts in the same commit, so the old one is never destroyed while shown.
     */
    const settledTask = settled?.task;
    useEffect(
        () => () => {
            // eslint-disable-next-line no-void -- teardown has nothing to report; a destroyed task cannot fail usefully
            void settledTask?.destroy();
        },
        [settledTask],
    );

    return {
        state: shownPdfRead(settled, { source, request: request.id, cause: request.cause }) ?? {
            status: 'loading',
        },
        retry: () => setRequest((current) => ({ id: current.id + 1, cause: 'open' })),
    };
}

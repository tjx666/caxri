import './pdf-preview.css';

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

import { MoveHorizontal, ZoomIn, ZoomOut } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { EditorLoadFailure } from '../editor/editor-load-failure';
import type { PdfViewerSession, PdfViewState } from './pdf-document';
import { createPdfViewerSession } from './pdf-document';
import { usePdfDocument } from './use-pdf-document';

function ToolbarButton({
    label,
    icon,
    onClick,
}: {
    label: string;
    icon: ReactElement;
    onClick: () => void;
}) {
    return (
        <Tooltip content={label}>
            <Button aria-label={label} size="icon" variant="ghost" onClick={onClick}>
                {icon}
            </Button>
        </Tooltip>
    );
}

/**
 * A parsed document mounted into pdf.js's viewer, with the page position and zoom controls above it. The viewer owns
 * the scroll container's children, so React renders only the empty element pdf.js fills.
 */
function PdfDocumentView({
    document,
    onRetry,
}: {
    document: PDFDocumentProxy;
    onRetry: () => void;
}) {
    const containerReference = useRef<HTMLDivElement>(null);
    const viewerReference = useRef<HTMLDivElement>(null);
    const sessionReference = useRef<PdfViewerSession | undefined>(undefined);
    const [view, setView] = useState<PdfViewState>({
        pageNumber: 1,
        pageCount: document.numPages,
        scale: 1,
    });
    const [viewerFailed, setViewerFailed] = useState(false);

    useEffect(() => {
        const container = containerReference.current;
        const viewerElement = viewerReference.current;
        if (!container || !viewerElement) return;
        let isDisposed = false;
        // eslint-disable-next-line no-void -- a failure to load the viewer chunk or mount the document is caught below
        void createPdfViewerSession({
            container,
            viewerElement,
            document,
            onViewChange: setView,
        })
            .then((session) => {
                if (isDisposed) session.dispose();
                else sessionReference.current = session;
            })
            .catch(() => {
                if (!isDisposed) setViewerFailed(true);
            });
        return () => {
            isDisposed = true;
            sessionReference.current?.dispose();
            sessionReference.current = undefined;
        };
    }, [document]);

    if (viewerFailed)
        return (
            <EditorLoadFailure
                actionLabel="Retry"
                reason="Couldn't display this PDF."
                onAction={onRetry}
            />
        );
    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <div className="flex h-8 flex-none items-center gap-1 bg-surface px-2 text-[12px] text-muted tabular-nums">
                <span aria-live="polite" className="min-w-0 flex-1 truncate">
                    Page {view.pageNumber} of {view.pageCount}
                </span>
                <ToolbarButton
                    icon={<ZoomOut aria-hidden="true" size={14} />}
                    label="Zoom Out"
                    onClick={() => sessionReference.current?.zoomOut()}
                />
                <span className="w-11 text-center">{Math.round(view.scale * 100)}%</span>
                <ToolbarButton
                    icon={<ZoomIn aria-hidden="true" size={14} />}
                    label="Zoom In"
                    onClick={() => sessionReference.current?.zoomIn()}
                />
                <ToolbarButton
                    icon={<MoveHorizontal aria-hidden="true" size={14} />}
                    label="Fit Width"
                    onClick={() => sessionReference.current?.fitWidth()}
                />
            </div>
            <div className="relative min-h-0 flex-1">
                <div
                    ref={containerReference}
                    aria-label="PDF preview"
                    className="caxri-pdf-preview absolute inset-0 overflow-auto"
                    data-testid="pdf-preview"
                    role="document"
                >
                    <div ref={viewerReference} className="pdfViewer" />
                </div>
            </div>
        </div>
    );
}

/**
 * The PDF reading view. It reads the whole file through `files.readAsset` once, then pdf.js renders only the pages in
 * view. It does not follow later changes to the file on disk: Retry, or reopening the tab, reads it again.
 */
export function PdfPreview({ sessionId, path }: { sessionId: string; path: string }) {
    const { state, retry } = usePdfDocument(sessionId, path);
    if (state.status === 'failed')
        return (
            <EditorLoadFailure
                actionLabel="Retry"
                reason={state.failure.reason}
                tone={state.failure.tone}
                onAction={retry}
            />
        );
    if (state.status === 'loading')
        return (
            <div className="flex h-full items-center justify-center bg-background text-muted">
                Loading PDF…
            </div>
        );
    return <PdfDocumentView document={state.document} onRetry={retry} />;
}

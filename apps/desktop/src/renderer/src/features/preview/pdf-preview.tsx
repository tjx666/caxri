import './pdf-preview.css';

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';

import { ChevronDown, ZoomIn, ZoomOut } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
    Menu,
    MenuContent,
    MenuRadioGroup,
    MenuRadioItem,
    MenuTrigger,
} from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { documentLoadRecoveryAction } from '../editor/document-load-recovery';
import { EditorLoadFailure } from '../editor/editor-load-failure';
import type { PdfViewerSession, PdfViewState } from './pdf-document';
import { createPdfViewerSession } from './pdf-document';
import type { PdfZoomChoice } from './pdf-toolbar-model';
import { describePdfView, parsePdfPageInput, PDF_ZOOM_CHOICES } from './pdf-toolbar-model';
import { PREVIEW_LOADING_LABEL } from './preview-registry';
import { readPreviewViewState, rememberPreviewViewState } from './preview-view-state';
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
 * The page field. It shows the current page and takes a page number on Enter; Escape or leaving the field puts the
 * current page back. It is keyed by the current page by its caller, so scrolling refreshes the shown number without
 * overwriting what the user is typing between page changes.
 */
function PageField({
    pageCount,
    pageNumber,
    onGoToPage,
}: {
    pageCount: number;
    pageNumber: number;
    onGoToPage: (pageNumber: number) => void;
}) {
    return (
        <Input
            aria-label="Page"
            appearance="inline"
            className="w-10 text-center tabular-nums"
            defaultValue={String(pageNumber)}
            inputMode="numeric"
            size="compact"
            onBlur={(event) => {
                event.currentTarget.value = String(pageNumber);
            }}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.currentTarget.value = String(pageNumber);
                    return;
                }
                if (event.key !== 'Enter') return;
                const target = parsePdfPageInput(event.currentTarget.value, pageCount, pageNumber);
                event.currentTarget.value = String(target);
                onGoToPage(target);
            }}
        />
    );
}

/**
 * The zoom percentage, which opens the zoom choices: the two fits and fixed scales. The checked row is the fit in
 * force, or the fixed scale matching the current zoom.
 */
function ZoomMenu({
    view,
    onZoom,
}: {
    view: PdfViewState;
    onZoom: (choice: PdfZoomChoice) => void;
}) {
    const checked =
        PDF_ZOOM_CHOICES.find(
            ({ choice }) => choice === view.scaleValue || choice === Number(view.scaleValue),
        )?.label ?? null;
    return (
        <Menu>
            <MenuTrigger
                aria-label={`Zoom: ${Math.round(view.scale * 100)}%`}
                render={
                    <Button
                        className="w-16 gap-0.5 px-1 text-[12px] tabular-nums"
                        size="sm"
                        variant="ghost"
                    />
                }
            >
                {Math.round(view.scale * 100)}%
                <ChevronDown aria-hidden="true" size={12} />
            </MenuTrigger>
            <MenuContent align="end" className="min-w-32">
                <MenuRadioGroup
                    value={checked}
                    onValueChange={(label: string) => {
                        const option = PDF_ZOOM_CHOICES.find((entry) => entry.label === label);
                        if (option) onZoom(option.choice);
                    }}
                >
                    {PDF_ZOOM_CHOICES.map(({ label }) => (
                        <MenuRadioItem key={label} closeOnClick value={label}>
                            {label}
                        </MenuRadioItem>
                    ))}
                </MenuRadioGroup>
            </MenuContent>
        </Menu>
    );
}

/**
 * A parsed document mounted into pdf.js's viewer, with the page field and zoom controls above it. The viewer owns the
 * scroll container's children, so React renders only the empty element pdf.js fills.
 *
 * The page, zoom, and scroll offset are remembered under `viewStateKey`, so switching tabs or reloading after the file
 * changed on disk returns to the same place. A reload passes the new `document` to the same view, which keeps showing
 * the old copy until then (see `usePdfDocument`).
 */
function PdfDocumentView({
    document,
    viewStateKey,
    onRetry,
}: {
    document: PDFDocumentProxy;
    viewStateKey: string;
    onRetry: () => void;
}) {
    const containerReference = useRef<HTMLDivElement>(null);
    const viewerReference = useRef<HTMLDivElement>(null);
    const sessionReference = useRef<PdfViewerSession | undefined>(undefined);
    /**
     * Set by a toolbar action and consumed by the next view report, so only a change the user asked for is announced.
     * Scrolling past a page boundary updates the field silently.
     */
    const isAnnouncementPendingReference = useRef(false);
    const [view, setView] = useState<PdfViewState>({
        pageNumber: 1,
        pageCount: document.numPages,
        scale: 1,
        scaleValue: 'page-width',
    });
    const [announcement, setAnnouncement] = useState('');
    /**
     * Tied to the document that failed to mount, so a reloaded document gets its own attempt without a reset effect.
     */
    const [failedDocument, setFailedDocument] = useState<PDFDocumentProxy>();

    useEffect(() => {
        const container = containerReference.current;
        const viewerElement = viewerReference.current;
        if (!container || !viewerElement) return;
        let isDisposed = false;
        const remembered = readPreviewViewState(viewStateKey);
        // eslint-disable-next-line no-void -- a failure to load the viewer chunk or mount the document is caught below
        void createPdfViewerSession({
            container,
            viewerElement,
            document,
            restored: remembered,
            onViewChange: (next) => {
                setView(next);
                rememberPreviewViewState(viewStateKey, {
                    pageNumber: next.pageNumber,
                    scaleValue: next.scaleValue,
                });
                if (!isAnnouncementPendingReference.current) return;
                isAnnouncementPendingReference.current = false;
                setAnnouncement(describePdfView(next.pageNumber, next.pageCount, next.scale));
            },
        })
            .then((session) => {
                if (isDisposed) session.dispose();
                else sessionReference.current = session;
            })
            .catch(() => {
                if (!isDisposed) setFailedDocument(document);
            });
        return () => {
            isDisposed = true;
            sessionReference.current?.dispose();
            sessionReference.current = undefined;
        };
    }, [document, viewStateKey]);

    if (failedDocument === document)
        return (
            <EditorLoadFailure
                actionLabel="Retry"
                reason="Couldn't display this PDF."
                onAction={onRetry}
            />
        );
    const act = (action: (session: PdfViewerSession) => void): void => {
        const session = sessionReference.current;
        if (!session) return;
        isAnnouncementPendingReference.current = true;
        action(session);
    };

    return (
        <div className="flex h-full min-h-0 flex-col bg-background">
            <div className="flex h-8 flex-none items-center gap-1 bg-surface px-2 text-[12px] text-muted tabular-nums">
                <PageField
                    key={view.pageNumber}
                    pageCount={view.pageCount}
                    pageNumber={view.pageNumber}
                    onGoToPage={(pageNumber) => act((session) => session.goToPage(pageNumber))}
                />
                <span className="min-w-0 flex-1 truncate">of {view.pageCount}</span>
                <span aria-live="polite" className="sr-only">
                    {announcement}
                </span>
                <ToolbarButton
                    icon={<ZoomOut aria-hidden="true" size={14} />}
                    label="Zoom Out"
                    onClick={() => act((session) => session.zoomOut())}
                />
                <ZoomMenu
                    view={view}
                    onZoom={(choice) => act((session) => session.setZoom(choice))}
                />
                <ToolbarButton
                    icon={<ZoomIn aria-hidden="true" size={14} />}
                    label="Zoom In"
                    onClick={() => act((session) => session.zoomIn())}
                />
            </div>
            <div className="relative min-h-0 flex-1">
                <div
                    ref={containerReference}
                    aria-label="PDF preview"
                    className="caxri-pdf-preview absolute inset-0 overflow-auto"
                    data-testid="pdf-preview"
                    role="document"
                    onScroll={(event) =>
                        rememberPreviewViewState(viewStateKey, {
                            scrollTop: event.currentTarget.scrollTop,
                        })
                    }
                >
                    <div ref={viewerReference} className="pdfViewer" />
                </div>
            </div>
        </div>
    );
}

/**
 * The PDF reading view. It reads the whole file through `files.readAsset`, then pdf.js renders only the pages in view.
 * When the file is rewritten on disk it reads it again and swaps the new copy in at the same page and zoom, keeping the
 * old copy on screen until the new one parses (see `usePdfDocument`).
 */
export function PdfPreview({
    path,
    sessionId,
    viewStateKey,
    workbenchProjectId,
}: {
    path: string;
    sessionId: string;
    viewStateKey: string;
    workbenchProjectId: string | undefined;
}) {
    const { state, retry } = usePdfDocument(sessionId, workbenchProjectId, path);
    if (state.status === 'failed')
        return (
            <EditorLoadFailure
                {...documentLoadRecoveryAction(state.failure.recovery, path, retry)}
                reason={state.failure.reason}
                tone={state.failure.tone}
            />
        );
    if (state.status === 'loading')
        return (
            <div className="flex h-full items-center justify-center bg-background text-muted">
                {PREVIEW_LOADING_LABEL}
            </div>
        );
    return (
        <PdfDocumentView document={state.document} viewStateKey={viewStateKey} onRetry={retry} />
    );
}

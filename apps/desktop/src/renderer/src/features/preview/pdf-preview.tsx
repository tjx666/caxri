import './pdf-preview.css';

import { useEffect, useRef, useState } from 'react';

import { ChevronDown, ChevronUp } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';

import { FindBar } from '../../components/find-bar';
import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { documentLoadRecoveryAction } from '../editor/document-load-recovery';
import { EditorLoadFailure } from '../editor/editor-load-failure';
import { usePdfDocument } from './hooks/use-pdf-document';
import { usePdfFind } from './hooks/use-pdf-find';
import type { PdfViewerSession, PdfViewState } from './pdf-document';
import { createPdfViewerSession } from './pdf-document';
import { isPdfFindMiss, isPdfFindShortcut, pdfFindCountLabel } from './pdf-find';
import { PdfPasswordForm } from './pdf-password-form';
import {
    adjacentPdfPage,
    describePdfView,
    parsePdfPageInput,
    PDF_ZOOM_CHOICES,
    pdfZoomChoiceLabel,
} from './pdf-toolbar-model';
import { PREVIEW_LOADING_LABEL_KEY } from './preview-registry';
import { readPreviewViewState, rememberPreviewViewState } from './preview-view-state';
import { ZoomControls } from './zoom-controls';

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
    const { t } = useTranslation();
    return (
        <Input
            aria-label={t('preview.pdf.page')}
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
 * Previous or next page beside the page field, so paging does not require typing a number or scrolling. It disables at
 * the document's edge.
 */
function PageStepButton({
    pageCount,
    pageNumber,
    step,
    onGoToPage,
}: {
    pageCount: number;
    pageNumber: number;
    step: -1 | 1;
    onGoToPage: (pageNumber: number) => void;
}) {
    const { t } = useTranslation();
    const target = adjacentPdfPage(pageNumber, step, pageCount);
    const label = t(step === -1 ? 'preview.pdf.previousPage' : 'preview.pdf.nextPage');
    return (
        <Tooltip content={label}>
            <Button
                aria-label={label}
                // `aria-disabled`, not `disabled`: stepping onto the last page with Enter must not evict keyboard focus
                // from the button the reader is pressing (see `Button`); the click handler refuses the edge itself.
                aria-disabled={target === undefined || undefined}
                size="icon"
                variant="ghost"
                onClick={() => target !== undefined && onGoToPage(target)}
            >
                {step === -1 ? (
                    <ChevronUp aria-hidden="true" size={14} />
                ) : (
                    <ChevronDown aria-hidden="true" size={14} />
                )}
            </Button>
        </Tooltip>
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
    const { t } = useTranslation();
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
    const find = usePdfFind(sessionReference, () => containerReference.current?.focus());
    const { attach: attachFind, report: reportFind } = find;

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
            onFindChange: reportFind,
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
                else {
                    sessionReference.current = session;
                    attachFind(session);
                }
            })
            .catch(() => {
                if (!isDisposed) setFailedDocument(document);
            });
        return () => {
            isDisposed = true;
            sessionReference.current?.dispose();
            sessionReference.current = undefined;
        };
    }, [attachFind, document, reportFind, viewStateKey]);

    if (failedDocument === document)
        return (
            <EditorLoadFailure
                actionLabel={t('common.retry')}
                reason={t('preview.pdf.displayFailed')}
                onAction={onRetry}
            />
        );
    const act = (action: (session: PdfViewerSession) => void): void => {
        const session = sessionReference.current;
        if (!session) return;
        isAnnouncementPendingReference.current = true;
        action(session);
    };
    const goToPage = (pageNumber: number) => act((session) => session.goToPage(pageNumber));

    return (
        <div
            className="flex h-full min-h-0 flex-col bg-background"
            onKeyDown={(event) => {
                if (!isPdfFindShortcut(event)) return;
                event.preventDefault();
                find.open();
            }}
        >
            <div className="flex h-8 flex-none items-center gap-1 bg-surface px-2 text-[12px] text-muted tabular-nums">
                <PageStepButton
                    pageCount={view.pageCount}
                    pageNumber={view.pageNumber}
                    step={-1}
                    onGoToPage={goToPage}
                />
                <PageField
                    key={view.pageNumber}
                    pageCount={view.pageCount}
                    pageNumber={view.pageNumber}
                    onGoToPage={goToPage}
                />
                <span className="flex-none">
                    {t('preview.pdf.pageCount', { count: view.pageCount })}
                </span>
                <PageStepButton
                    pageCount={view.pageCount}
                    pageNumber={view.pageNumber}
                    step={1}
                    onGoToPage={goToPage}
                />
                <span aria-hidden="true" className="min-w-0 flex-1" />
                <span aria-live="polite" className="sr-only">
                    {announcement}
                </span>
                {/*
                 * `Cmd+=`/`Cmd+-`/`Cmd+0` stay window zoom: native menu accelerators consume those chords before the
                 * Renderer sees them, so the PDF zooms through these buttons rather than a hijacked shortcut.
                 */}
                <ZoomControls
                    checked={PDF_ZOOM_CHOICES.find(
                        (choice) =>
                            choice === view.scaleValue || choice === Number(view.scaleValue),
                    )}
                    choiceLabel={(choice) => pdfZoomChoiceLabel(choice, t)}
                    choices={PDF_ZOOM_CHOICES}
                    scale={view.scale}
                    onZoom={(choice) => act((session) => session.setZoom(choice))}
                    onZoomIn={() => act((session) => session.zoomIn())}
                    onZoomOut={() => act((session) => session.zoomOut())}
                />
            </div>
            {find.isOpen && (
                <FindBar
                    ariaLabel={t('preview.pdf.find')}
                    countLabel={pdfFindCountLabel(find.query, find.result, t)}
                    focusRevision={find.focusRevision}
                    hasMatches={find.result.total > 0}
                    inputLabel={t('preview.pdf.find')}
                    isDocked
                    isNoMatch={isPdfFindMiss(find.query, find.result)}
                    query={find.query}
                    onClose={find.close}
                    onNext={find.next}
                    onPrevious={find.previous}
                    onQueryChange={find.changeQuery}
                />
            )}
            <div className="relative min-h-0 flex-1">
                <div
                    ref={containerReference}
                    aria-label={t('preview.pdf.label')}
                    className="caxri-pdf-preview absolute inset-0 overflow-auto outline-none focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-accent"
                    data-testid="pdf-preview"
                    role="document"
                    // Focusable so a click on a page puts `Cmd+F` and the arrow keys inside the preview.
                    tabIndex={0}
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
    const { t } = useTranslation();
    const { state, isCheckingPassword, retry, submitPassword } = usePdfDocument(
        sessionId,
        workbenchProjectId,
        path,
    );
    if (state.status === 'failed')
        return (
            <EditorLoadFailure
                {...documentLoadRecoveryAction(state.failure.recovery, path, retry, t)}
                reason={state.failure.reason}
                tone={state.failure.tone}
            />
        );
    if (state.status === 'password')
        return (
            <PdfPasswordForm
                // A different protected file starts with an empty field.
                key={path}
                attempt={state.attempt}
                isChecking={isCheckingPassword}
                isIncorrect={state.isIncorrect}
                onSubmit={submitPassword}
            />
        );
    if (state.status === 'loading')
        return (
            <LoadingSkeleton
                variant="document"
                className="bg-background"
                label={t(PREVIEW_LOADING_LABEL_KEY)}
            />
        );
    return (
        <PdfDocumentView document={state.document} viewStateKey={viewStateKey} onRetry={retry} />
    );
}

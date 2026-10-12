import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist';
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import type * as PdfViewerModule from 'pdfjs-dist/web/pdf_viewer.mjs';

import { openExternalUrl } from '../../lib/external-link';
import { pushToast } from '../../stores/toasts';
import { InlinePdfBinaryDataFactory } from './pdf-binary-data';
import type { PdfZoomChoice } from './pdf-toolbar-model';
import { clampPdfPageNumber } from './pdf-toolbar-model';

/**
 * Zoom bounds and the fit the viewer opens at. `page-width` matches how a reader opens a PDF in a narrow editor pane:
 * the text is legible immediately, and scrolling moves through pages.
 */
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const INITIAL_SCALE = 'page-width';
const FIT_PRESETS: ReadonlySet<string> = new Set(['page-width', 'page-fit', 'auto']);

/**
 * What a remembered view needs to be shown again: the zoom as pdf.js's scale value, and the scroll offset or, when the
 * offset cannot apply (a different zoom produced different page heights), the page.
 */
export interface PdfRestoredView {
    pageNumber?: number;
    scaleValue?: string;
    scrollTop?: number;
}

const shared = {
    worker: undefined as Worker | undefined,
    viewerModule: undefined as Promise<typeof PdfViewerModule> | undefined,
};

/**
 * The viewer components read the core library from `globalThis.pdfjsLib` when their module evaluates instead of
 * importing it, so the global is published first and the module is imported after it.
 */
function loadViewerModule(): Promise<typeof PdfViewerModule> {
    // eslint-disable-next-line unicorn/no-global-object-property-assignment -- pdf.js's viewer reads this global, see above
    (globalThis as { pdfjsLib?: unknown }).pdfjsLib ??= pdfjs;
    shared.viewerModule ??= import('pdfjs-dist/web/pdf_viewer.mjs');
    return shared.viewerModule;
}

/**
 * One pdf.js worker for every open PDF. Vite bundles it as an ordinary module worker, the same way Monaco's workers
 * load, so it starts from `'self'` under the Renderer CSP in both the dev server and the packaged `file://` page.
 * Documents share it through `workerPort`, and destroying one document never terminates it.
 */
function ensureWorker(): void {
    shared.worker ??= new PdfWorker();
    pdfjs.GlobalWorkerOptions.workerPort = shared.worker;
}

/**
 * Starts parsing a PDF from bytes the Renderer already read through `files.readAsset`. pdf.js never fetches the file
 * itself, so it has no URL to reach the filesystem or the network with.
 */
export function loadPdfDocument(data: Uint8Array): PDFDocumentLoadingTask {
    ensureWorker();
    return pdfjs.getDocument({
        data,
        // Built-in CMaps, fonts, and decoders come from the bundle, never from a URL (see `pdf-binary-data.ts`).
        BinaryDataFactory: InlinePdfBinaryDataFactory,
        useWorkerFetch: false,
        enableXfa: false,
    });
}

export interface PdfViewState {
    pageNumber: number;
    pageCount: number;
    /**
     * Current zoom as a fraction, 1 being the page's natural size.
     */
    scale: number;
    /**
     * Pdf.js's scale value: a fit preset (`page-width`, `page-fit`) while one is in force, else the numeric scale.
     */
    scaleValue: string;
}

export interface PdfViewerSession {
    zoomIn(): void;
    zoomOut(): void;
    setZoom(choice: PdfZoomChoice): void;
    /**
     * Scrolls the page to the top of the view. Out-of-range numbers are clamped to the document.
     */
    goToPage(pageNumber: number): void;
    dispose(): void;
}

/**
 * Sends an external link inside the PDF to the system browser. The annotation layer renders it as an ordinary anchor,
 * and following it in place would navigate the Workbench, which Main refuses; in-document links carry a fragment and
 * are left to pdf.js.
 */
function handleLinkClick(event: MouseEvent): void {
    const anchor = (event.target as Element | null)?.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement)) return;
    if (!/^(?:https?|mailto):/i.test(anchor.href)) return;
    event.preventDefault();
    // eslint-disable-next-line no-void -- `openExternalUrl` reports its own failure through the toast it is given
    void openExternalUrl(anchor.href, (message) => pushToast('error', message));
}

/**
 * Mounts a loaded document into `container` with pdf.js's own viewer: it lays out every page at its real size, renders
 * only the pages in view (re-rendering them sharply after a zoom), and adds a selectable text layer and clickable
 * links. Forms, scripting, and annotation editing stay off: this is a reader.
 */
export async function createPdfViewerSession({
    container,
    viewerElement,
    document,
    onViewChange,
    restored,
}: {
    container: HTMLDivElement;
    viewerElement: HTMLDivElement;
    document: PDFDocumentProxy;
    onViewChange: (state: PdfViewState) => void;
    /**
     * Where this pane last showed the document, so a tab switch or a reload after the file changed on disk returns to
     * the same page and zoom instead of page 1 at page width.
     */
    restored?: PdfRestoredView;
}): Promise<PdfViewerSession> {
    const { EventBus, PDFLinkService, PDFViewer } = await loadViewerModule();
    const abort = new AbortController();
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    /**
     * `abortSignal` is read by the pdf.js 6 viewer at runtime but missing from its `PDFViewerOptions` type. Without it
     * the viewer's own resize observer, container scroll watcher, and the text layer's document-level selection
     * listeners outlive the tab.
     */
    const options: ConstructorParameters<typeof PDFViewer>[0] & { abortSignal: AbortSignal } = {
        container,
        viewer: viewerElement,
        eventBus,
        linkService,
        removePageBorders: true,
        annotationMode: pdfjs.AnnotationMode.ENABLE,
        abortSignal: abort.signal,
    };
    const viewer = new PDFViewer(options);
    linkService.setViewer(viewer);
    const report = (): void =>
        onViewChange({
            pageNumber: viewer.currentPageNumber,
            pageCount: document.numPages,
            scale: viewer.currentScale,
            scaleValue: viewer.currentScaleValue,
        });
    eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = restored?.scaleValue ?? INITIAL_SCALE;
        /**
         * The offset is exact when the zoom and pane width match what produced it, which is the tab-switch case; a page
         * that the restored offset does not land on means the layout changed (another pane width, a shorter document),
         * and the page is the better promise. pdf.js only re-reads the visible page on its next animation frame, so
         * `update()` refreshes `currentPageNumber` from the restored offset before the comparison.
         */
        if (restored?.scrollTop !== undefined) {
            container.scrollTop = restored.scrollTop;
            viewer.update();
        }
        if (restored?.pageNumber !== undefined && viewer.currentPageNumber !== restored.pageNumber)
            viewer.currentPageNumber = clampPdfPageNumber(
                restored.pageNumber,
                document.numPages,
                1,
            );
        report();
    });
    eventBus.on('pagechanging', report);
    eventBus.on('scalechanging', report);
    viewer.setDocument(document);
    linkService.setDocument(document);

    container.addEventListener('click', handleLinkClick, { signal: abort.signal });
    /**
     * Chromium reports a trackpad pinch as a Ctrl+wheel. Unclaimed it would zoom nothing and only scroll, so it zooms
     * the document around the pointer, the way every PDF reader does.
     */
    container.addEventListener(
        'wheel',
        (event) => {
            if (!event.ctrlKey) return;
            event.preventDefault();
            viewer.updateScale({
                scaleFactor: Math.exp(-event.deltaY / 100),
                origin: [event.clientX, event.clientY],
            });
        },
        { passive: false, signal: abort.signal },
    );
    /**
     * A fit preset is relative to the pane, so it is re-applied when the pane resizes (a split, a sidebar toggle); an
     * explicit zoom is the reader's choice and stays.
     */
    const resize = new ResizeObserver(() => {
        const preset = viewer.currentScaleValue;
        if (FIT_PRESETS.has(preset)) viewer.currentScaleValue = preset;
    });
    resize.observe(container);

    const clamp = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
    return {
        zoomIn: () => {
            if (viewer.currentScale < MAX_SCALE) viewer.increaseScale();
            viewer.currentScale = clamp(viewer.currentScale);
        },
        zoomOut: () => {
            if (viewer.currentScale > MIN_SCALE) viewer.decreaseScale();
            viewer.currentScale = clamp(viewer.currentScale);
        },
        setZoom: (choice) => {
            if (typeof choice === 'number') viewer.currentScale = clamp(choice);
            else viewer.currentScaleValue = choice;
        },
        goToPage: (pageNumber) => {
            viewer.currentPageNumber = clampPdfPageNumber(
                pageNumber,
                document.numPages,
                viewer.currentPageNumber,
            );
        },
        dispose: () => {
            resize.disconnect();
            abort.abort();
            viewer.cleanup();
            linkService.setDocument(null);
            viewer.setDocument(null);
        },
    };
}

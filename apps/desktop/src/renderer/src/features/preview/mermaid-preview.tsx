import { useDeferredValue, useEffect, useRef } from 'react';

import type { ThemeTokens } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { labelDiagram, renderMermaidDiagram, sizeDiagramNaturally } from './markdown-diagrams';
import { PreviewEmptyState } from './preview-empty-state';
import { PreviewZoomView } from './preview-zoom-view';

/**
 * The reading view for a `.mmd` / `.mermaid` file: the whole file is one diagram.
 *
 * It renders through the same path as a `mermaid` fence in the Markdown preview, so the two never disagree on theme
 * colors or on how a syntax error reads. The source comes from the editor's buffer and is deferred, so typing in the
 * source pane re-lays out the diagram at low priority. A half-typed edge keeps the last diagram that parsed, dimmed,
 * with the parser's error below it, until the source parses again.
 *
 * The diagram zooms and pans (see `PreviewZoomView`), opening at Fit.
 */
export function MermaidPreview({
    fileName,
    source,
    sourcePath,
    theme,
    viewStateKey,
}: {
    /**
     * The diagram file's name, which the diagram's accessible name carries (`Mermaid diagram: flow.mmd`).
     */
    fileName: string;
    source: string;
    /**
     * The Project file behind the diagram, so an empty diagram offers Open Source; absent for an external document.
     */
    sourcePath?: string;
    theme: ThemeTokens;
    viewStateKey: string;
}) {
    const { t } = useTranslation();
    const diagramReference = useRef<HTMLElement>(null);
    const deferredSource = useDeferredValue(source);
    const isEmpty = deferredSource.trim() === '';

    const label = t('preview.mermaid.fileLabel', { name: fileName });

    useEffect(() => {
        const element = diagramReference.current;
        if (!element || isEmpty) return;
        const controller = new AbortController();
        // eslint-disable-next-line no-void -- a failed render paints its own error into the element
        void renderMermaidDiagram(element, deferredSource, theme, controller.signal).then(() => {
            sizeDiagramNaturally(element);
            labelDiagram(element, label);
        });
        return () => controller.abort();
    }, [deferredSource, isEmpty, label, theme]);

    if (isEmpty) return <PreviewEmptyState title={t('preview.mermaid.empty')} path={sourcePath} />;
    return (
        <div className="caxri-markdown flex h-full min-h-0 flex-col bg-background text-foreground">
            <PreviewZoomView viewStateKey={viewStateKey}>
                {/* A figure rather than an image: an image hides its children from assistive technology, and the parse
                    error rendered inside it has to be readable. */}
                <figure
                    ref={diagramReference}
                    aria-label={label}
                    className="caxri-markdown-diagram caxri-mermaid-file-diagram m-0"
                    data-testid="mermaid-preview"
                />
            </PreviewZoomView>
        </div>
    );
}

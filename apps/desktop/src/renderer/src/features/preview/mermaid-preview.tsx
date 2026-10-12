import { useDeferredValue, useEffect, useRef } from 'react';

import type { ThemeTokens } from '@caxri/protocol';

import { useTranslation } from '../../i18n';
import { renderMermaidDiagram } from './markdown-diagrams';

/**
 * The reading view for a `.mmd` / `.mermaid` file: the whole file is one diagram.
 *
 * It renders through the same path as a `mermaid` fence in the Markdown preview, so the two never disagree on theme
 * colors or on how a syntax error reads. The source comes from the editor's buffer and is deferred, so typing in the
 * source pane re-lays out the diagram at low priority. A half-typed edge keeps the last diagram that parsed, dimmed,
 * with the parser's error below it, until the source parses again.
 */
export function MermaidPreview({ source, theme }: { source: string; theme: ThemeTokens }) {
    const { t } = useTranslation();
    const diagramReference = useRef<HTMLElement>(null);
    const deferredSource = useDeferredValue(source);
    const isEmpty = deferredSource.trim() === '';

    useEffect(() => {
        const element = diagramReference.current;
        if (!element || isEmpty) return;
        const controller = new AbortController();
        // eslint-disable-next-line no-void -- a failed render paints its own error into the element
        void renderMermaidDiagram(element, deferredSource, theme, controller.signal);
        return () => controller.abort();
    }, [deferredSource, isEmpty, theme]);

    return (
        <div className="caxri-markdown h-full min-h-0 overflow-auto bg-background px-8 py-6 text-foreground">
            {isEmpty ? (
                <p className="text-muted">{t('preview.mermaid.empty')}</p>
            ) : (
                // A figure rather than an image: an image hides its children from assistive technology, and the
                // parse error rendered inside it has to be readable.
                <figure
                    ref={diagramReference}
                    aria-label={t('preview.mermaid.label')}
                    className="caxri-markdown-diagram caxri-mermaid-file-diagram m-0"
                    data-testid="mermaid-preview"
                />
            )}
        </div>
    );
}

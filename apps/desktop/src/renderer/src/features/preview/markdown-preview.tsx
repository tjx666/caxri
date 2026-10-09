import { useDeferredValue, useEffect, useMemo, useRef } from 'react';

import { renderMarkdown } from '@caxri/markdown';
import type { ThemeTokens } from '@caxri/protocol';

import { decorateCodeBlocks } from './markdown-code-blocks';
import { renderDiagrams } from './markdown-diagrams';
import { attachImages } from './markdown-images';
import { createPreviewLinkHandler } from './markdown-links';
import { sanitizeMarkdownHtml } from './markdown-sanitize';
import { followSourceScroll } from './markdown-scroll-follow';

export interface MarkdownPreviewProperties {
    sessionId: string;
    /**
     * Absolute path of the document being previewed; resolves its relative images and links.
     */
    documentPath: string;
    projectRoot: string;
    source: string;
    theme: ThemeTokens;
}

/**
 * The Markdown reading view.
 *
 * The engine produces one HTML string and this component mounts it, then walks the result to give code blocks the
 * editor's colors and a copy button, Mermaid fences a rendered diagram, images an authorized object URL, and links a
 * Workbench action. Keeping the document a string rather than a React tree is what lets the same pipeline render into a
 * mobile WebView later without a second implementation.
 *
 * Re-rendering is driven by the Session's document cache, so typing in the source editor updates the preview. The
 * source text is deferred: a large document's render then runs at low priority and never delays a keystroke.
 */
export function MarkdownPreview({
    sessionId,
    documentPath,
    projectRoot,
    source,
    theme,
}: MarkdownPreviewProperties) {
    const containerReference = useRef<HTMLDivElement>(null);
    const scrollTopReference = useRef(0);
    const deferredSource = useDeferredValue(source);
    const rendered = useMemo(() => {
        const result = renderMarkdown(deferredSource, { documentPath, projectRoot });
        return { ...result, html: sanitizeMarkdownHtml(result.html) };
    }, [deferredSource, documentPath, projectRoot]);
    const linksReference = useRef(rendered.links);
    const followedPathReference = useRef<string | undefined>(undefined);

    useEffect(() => {
        const container = containerReference.current;
        if (!container) return;
        // Read through a ref so one registration survives every re-render of the document below it.
        const handler = createPreviewLinkHandler(container, () => linksReference.current);
        container.addEventListener('click', handler);
        return () => container.removeEventListener('click', handler);
    }, []);

    useEffect(() => {
        const container = containerReference.current;
        if (!container) return;
        // The click handler above resolves a link through this ref, so the table it reads is refreshed here rather
        // than during render.
        linksReference.current = rendered.links;
        // React replaced the whole document; without this the view jumps to the top on every keystroke.
        container.scrollTop = scrollTopReference.current;
        const controller = new AbortController();
        const releaseImages = attachImages(
            container,
            rendered.assets,
            sessionId,
            controller.signal,
        );
        decorateCodeBlocks(container, rendered.codeBlocks, theme, controller.signal);
        // eslint-disable-next-line no-void -- diagram failures are rendered in their own placeholders
        void renderDiagrams(container, rendered.diagrams, theme, controller.signal);
        const shouldRevealLastPosition = followedPathReference.current !== documentPath;
        followedPathReference.current = documentPath;
        const stopFollowing = followSourceScroll(container, documentPath, {
            shouldRevealLastPosition,
        });
        return () => {
            controller.abort();
            stopFollowing();
            releaseImages();
        };
    }, [documentPath, rendered, sessionId, theme]);

    return (
        <div
            className="caxri-markdown h-full min-h-0 overflow-auto bg-background px-8 py-6 text-foreground"
            ref={containerReference}
            onScroll={(event) => {
                scrollTopReference.current = event.currentTarget.scrollTop;
            }}
            // Sanitized immediately above by `sanitizeMarkdownHtml`; the engine emits untrusted HTML by design.
            dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
    );
}

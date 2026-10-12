import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import { renderMarkdown } from '@caxri/markdown';
import type { ThemeTokens } from '@caxri/protocol';

import { decorateCodeBlocks } from './markdown-code-blocks';
import { renderDiagrams } from './markdown-diagrams';
import { attachImages } from './markdown-images';
import { createPreviewLinkHandler } from './markdown-links';
import { sanitizeMarkdownHtml } from './markdown-sanitize';
import { followSourceScroll } from './markdown-scroll-follow';
import type { PreviewAssetSource } from './preview-asset-client';
import { readPreviewViewState, rememberPreviewViewState } from './preview-view-state';

export interface MarkdownPreviewProperties {
    sessionId: string;
    /**
     * Set for an external document: its relative images and links are read through Main's grant for the document's
     * folder, which is then `projectRoot`, instead of through the Session's Project.
     */
    externalDocumentId?: string;
    /**
     * Absolute path of the document being previewed; resolves its relative images and links.
     */
    documentPath: string;
    /**
     * Root that relative images and links must stay inside: the Project, or an external document's folder.
     */
    projectRoot: string;
    source: string;
    theme: ThemeTokens;
    /**
     * Identity of this preview in this pane, under which its scroll position survives a tab switch (see
     * `preview-view-state.ts`).
     */
    viewStateKey: string;
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
    externalDocumentId,
    documentPath,
    projectRoot,
    source,
    theme,
    viewStateKey,
}: MarkdownPreviewProperties) {
    const containerReference = useRef<HTMLDivElement>(null);
    /**
     * Seeded once from the position this pane last showed, so returning to the tab lands where the reader left it.
     */
    const [restoredScrollTop] = useState(() => readPreviewViewState(viewStateKey)?.scrollTop);
    const scrollTopReference = useRef(restoredScrollTop ?? 0);
    const deferredSource = useDeferredValue(source);
    const rendered = useMemo(() => {
        const result = renderMarkdown(deferredSource, { documentPath, projectRoot });
        return { ...result, html: sanitizeMarkdownHtml(result.html) };
    }, [deferredSource, documentPath, projectRoot]);
    const assetSource = useMemo<PreviewAssetSource>(
        () =>
            externalDocumentId === undefined
                ? { sessionId }
                : { externalDocumentId, directory: projectRoot },
        [externalDocumentId, projectRoot, sessionId],
    );
    const linksReference = useRef(rendered.links);
    const assetSourceReference = useRef(assetSource);
    const followedPathReference = useRef<string | undefined>(undefined);

    useEffect(() => {
        const container = containerReference.current;
        if (!container) return;
        // Read through a ref so one registration survives every re-render of the document below it.
        const handler = createPreviewLinkHandler(
            container,
            () => linksReference.current,
            () => assetSourceReference.current,
        );
        container.addEventListener('click', handler);
        return () => container.removeEventListener('click', handler);
    }, []);

    useEffect(() => {
        const container = containerReference.current;
        if (!container) return;
        // The click handler above resolves a link through this ref, so the table it reads is refreshed here rather
        // than during render.
        linksReference.current = rendered.links;
        assetSourceReference.current = assetSource;
        // React replaced the whole document; without this the view jumps to the top on every keystroke.
        container.scrollTop = scrollTopReference.current;
        const controller = new AbortController();
        const releaseImages = attachImages(
            container,
            rendered.assets,
            assetSource,
            controller.signal,
        );
        decorateCodeBlocks(container, rendered.codeBlocks, theme, controller.signal);
        // eslint-disable-next-line no-void -- diagram failures are rendered in their own placeholders
        void renderDiagrams(container, rendered.diagrams, theme, controller.signal);
        /**
         * A remembered preview position is more specific than the editor's last line, so it wins on the first attach;
         * the editor still drives the preview from the next source scroll on.
         */
        const shouldRevealLastPosition =
            followedPathReference.current !== documentPath &&
            (followedPathReference.current !== undefined || restoredScrollTop === undefined);
        followedPathReference.current = documentPath;
        const stopFollowing = followSourceScroll(container, documentPath, {
            shouldRevealLastPosition,
        });
        return () => {
            controller.abort();
            stopFollowing();
            releaseImages();
        };
    }, [assetSource, documentPath, rendered, restoredScrollTop, theme]);

    return (
        <div
            className="caxri-markdown h-full min-h-0 overflow-auto bg-background px-8 py-6 text-foreground"
            ref={containerReference}
            onScroll={(event) => {
                scrollTopReference.current = event.currentTarget.scrollTop;
                rememberPreviewViewState(viewStateKey, { scrollTop: scrollTopReference.current });
            }}
            // Sanitized immediately above by `sanitizeMarkdownHtml`; the engine emits untrusted HTML by design.
            dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
    );
}

import type { DocumentLocation } from './document-paths.js';

/**
 * One image the rendered HTML refers to by id instead of by path.
 *
 * The pipeline never emits a filesystem path into `src`: the host reads the bytes through its own authorized channel
 * and swaps in an object URL. That keeps the same HTML usable from a Renderer, from a mobile WebView, and under a
 * Content-Security-Policy that forbids loading local files.
 */
export interface MarkdownAsset {
    id: string;
    /**
     * Target exactly as the document wrote it, used for the failure placeholder.
     */
    source: string;
    /**
     * Absolute path inside the Project root, absent when the target escapes it or is an external URL.
     */
    path?: string;
    /**
     * External image URLs stay addressable directly.
     */
    url?: string;
}

/**
 * One fenced code block, kept out of the HTML so highlighting and copying work from the exact source text.
 */
export interface MarkdownCodeBlock {
    id: string;
    language: string;
    code: string;
}

/**
 * One `mermaid` fenced block, rendered by the host after mount because the renderer is loaded on demand.
 */
export interface MarkdownDiagram {
    id: string;
    source: string;
}

/**
 * One link the host must handle itself: an external URL, or another document inside the Project.
 */
export interface MarkdownLink {
    id: string;
    href: string;
    /**
     * Absolute path inside the Project root for a document-relative link.
     */
    path?: string;
    external: boolean;
}

export interface MarkdownRenderResult {
    /**
     * Rendered HTML. Still untrusted: the host sanitizes it before insertion, matching VS Code's split where the engine
     * renders and the view sanitizes.
     */
    html: string;
    assets: readonly MarkdownAsset[];
    codeBlocks: readonly MarkdownCodeBlock[];
    diagrams: readonly MarkdownDiagram[];
    links: readonly MarkdownLink[];
}

export type MarkdownRenderOptions = DocumentLocation;

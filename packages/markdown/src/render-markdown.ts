import { createMarkdownEngine, createRenderEnvironment } from './markdown-engine.js';
import type { MarkdownRenderOptions, MarkdownRenderResult } from './types.js';

/**
 * One engine per process. markdown-it instances are stateless between renders (all per-document state lives in the
 * environment object passed to `render`) so rebuilding one per keystroke would only cost rule-table setup.
 */
const state = { engine: undefined as ReturnType<typeof createMarkdownEngine> | undefined };

/**
 * Renders Markdown to HTML plus the side tables the host needs: images to resolve, code blocks to highlight and copy,
 * Mermaid diagrams to draw, and links to route.
 *
 * The returned HTML is untrusted. Sanitize it at the point of insertion.
 */
export function renderMarkdown(
    source: string,
    options: MarkdownRenderOptions,
): MarkdownRenderResult {
    state.engine ??= createMarkdownEngine();
    const environment = createRenderEnvironment(options);
    const html = state.engine.render(source, environment);
    return {
        html,
        assets: environment.assets,
        codeBlocks: environment.codeBlocks,
        diagrams: environment.diagrams,
        links: environment.links,
    };
}

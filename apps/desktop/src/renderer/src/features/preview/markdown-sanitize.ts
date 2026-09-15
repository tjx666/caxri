import DOMPurify from 'dompurify';

/**
 * Strips everything executable out of rendered Markdown before it reaches the DOM.
 *
 * `@caxri/markdown` keeps raw inline HTML (`<details>`, centered banners) because real READMEs depend on it, which
 * makes its output untrusted by construction. Sanitizing here rather than inside the engine is the split VS Code uses
 * too: the engine renders, the view decides what its own document is allowed to contain.
 *
 * Table alignment arrives as `style="text-align:…"` from markdown-it, so the `style` attribute stays allowed; the
 * Renderer's Content-Security-Policy is what keeps a stylesheet or image from reaching an unexpected origin.
 *
 * `style` is forbidden as an _element_ for a reason VS Code does not have: its preview owns a separate webview
 * document, while this one renders inside the Workbench, where a document-supplied stylesheet would restyle the whole
 * application. markdown-it never emits a `<style>` element, so forbidding it costs nothing. The companion half of that
 * containment is `contain: layout paint` on `.caxri-markdown`, which keeps a positioned element inside the preview.
 */
const FORBIDDEN_TAGS = [
    'base',
    'embed',
    'form',
    'iframe',
    'link',
    'meta',
    'object',
    'script',
    'style',
];
const FORBIDDEN_ATTRIBUTES = ['srcdoc'];

export function sanitizeMarkdownHtml(html: string): string {
    return DOMPurify.sanitize(html, {
        FORBID_TAGS: FORBIDDEN_TAGS,
        FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
    });
}

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
 */
const FORBIDDEN_TAGS = ['base', 'embed', 'form', 'iframe', 'link', 'meta', 'object', 'script'];
const FORBIDDEN_ATTRIBUTES = ['srcdoc'];

export function sanitizeMarkdownHtml(html: string): string {
    return DOMPurify.sanitize(html, {
        FORBID_TAGS: FORBIDDEN_TAGS,
        FORBID_ATTR: FORBIDDEN_ATTRIBUTES,
    });
}

import type { MarkdownCodeBlock } from '@caxri/markdown';

import {
    COPY_FEEDBACK_RESET_MS,
    copyButtonLabel,
    writeToClipboardWithFeedback,
} from '../../components/copy-feedback';
import { monaco } from '../../lib/monaco';
import { PreviewMemoCache } from './preview-memo-cache';

/**
 * Lucide's `copy` and `check` glyphs, inlined because these buttons are built with plain DOM calls rather than React,
 * the preview body is one sanitized HTML string, so there is no element tree for `lucide-react` to render into. Kept at
 * the same 24-unit viewBox and 2-unit stroke as every icon the component layer draws.
 */
const COPY_GLYPH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect>' +
    '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
const CHECK_GLYPH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 6 9 17l-5-5"></path></svg>';

/**
 * Colorized markup keyed by language and code. A live preview re-renders on every keystroke, and only the edited block
 * actually changed.
 */
const colorizedBlocks = new PreviewMemoCache<string>(256);

/**
 * Maps a fence info string onto a registered Monaco language.
 *
 * Monaco is the single source of truth for what `ts`, `typescript`, and `.ts` all mean, so the fence word is matched
 * against each registration's id, aliases, and extensions rather than against a second hand-written table that would
 * drift from the editor's own highlighting.
 */
function monacoLanguageId(fence: string): string | undefined {
    const wanted = fence.trim().toLowerCase();
    if (!wanted) return undefined;
    for (const language of monaco.languages.getLanguages()) {
        if (language.id.toLowerCase() === wanted) return language.id;
        if (language.aliases?.some((alias) => alias.toLowerCase() === wanted)) return language.id;
        if (
            language.extensions?.some(
                (extension) => extension.replace('.', '').toLowerCase() === wanted,
            )
        )
            return language.id;
    }
    return undefined;
}

async function colorize(code: string, languageId: string): Promise<string> {
    const key = `${languageId}\0${code}`;
    const cached = colorizedBlocks.get(key);
    if (cached !== undefined) return cached;
    const html = await monaco.editor.colorize(code, languageId, {});
    colorizedBlocks.set(key, html);
    return html;
}

async function paintCodeBlock(
    element: HTMLElement,
    block: MarkdownCodeBlock,
    signal: AbortSignal,
): Promise<void> {
    const languageId = monacoLanguageId(block.language);
    if (!languageId) return;
    const html = await colorize(block.code, languageId);
    if (signal.aborted) return;
    const code = element.querySelector('code');
    if (code) code.innerHTML = html;
}

function attachCopyButton(element: HTMLElement, code: string, signal: AbortSignal): void {
    const button = element.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'caxri-markdown-copy';
    button.title = 'Copy';
    button.setAttribute('aria-label', 'Copy code block');
    button.innerHTML = COPY_GLYPH;
    const state = { reset: undefined as ReturnType<typeof setTimeout> | undefined };
    const copy = async (): Promise<void> => {
        const status = await writeToClipboardWithFeedback(navigator.clipboard, code);
        button.innerHTML = status === 'copied' ? CHECK_GLYPH : COPY_GLYPH;
        button.title = copyButtonLabel(status, 'Copy');
        button.dataset.state = status;
        clearTimeout(state.reset);
        state.reset = setTimeout(() => {
            button.innerHTML = COPY_GLYPH;
            button.title = 'Copy';
            delete button.dataset.state;
        }, COPY_FEEDBACK_RESET_MS);
    };
    button.addEventListener(
        'click',
        (event) => {
            event.preventDefault();
            // Fire-and-forget: `writeToClipboardWithFeedback` resolves to a status instead of rejecting, and the
            // button itself is the only place that outcome is reported.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void copy();
        },
        { signal },
    );
    signal.addEventListener('abort', () => clearTimeout(state.reset), { once: true });
    element.append(button);
}

/**
 * Gives every fenced block the editor's own colors and a copy affordance.
 *
 * Highlighting runs through `monaco.editor.colorize` against the live `caxri-active` theme, so a code block in the
 * preview and the same lines in the editor are painted from one set of token colors, and the preview needs no second
 * highlighting library to stay in sync when the theme changes.
 */
export function decorateCodeBlocks(
    container: HTMLElement,
    blocks: readonly MarkdownCodeBlock[],
    signal: AbortSignal,
): void {
    for (const block of blocks) {
        const element = container.querySelector(`[data-caxri-code="${CSS.escape(block.id)}"]`);
        if (!(element instanceof HTMLElement)) continue;
        /**
         * React only replaces the body when the sanitized HTML string itself changed, so this pass can run against a
         * block that already carries a button: a theme switch, or an edit that sanitizes to the same bytes. Without
         * this the buttons stack invisibly, one per re-render, since they all sit at the same offset.
         */
        element.querySelector('.caxri-markdown-copy')?.remove();
        attachCopyButton(element, block.code, signal);
        // Fire-and-forget: an unhighlightable block simply keeps its plain-text rendering.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void paintCodeBlock(element, block, signal);
    }
}

import type { ThemeTokens } from '@caxri/protocol';

import { MemoCache } from './memo-cache';
import type * as MonacoModule from './monaco';

/**
 * Colorized markup keyed by theme, language, and code. A live preview re-renders on every keystroke and a Chat reply on
 * every streamed delta, and only the edited block actually changed.
 */
const colorizedBlocks = new MemoCache<string>(256);

/**
 * `monaco.editor.colorize` escapes the source and wraps it only in color-class spans, line breaks, and one container.
 * Anything else means the output contract changed, and the caller falls back to plain text instead of inserting it.
 */
const COLORIZED_MARKUP =
    /^(?:<\/?(?:div|span)(?: class="[\w -]*")?>|<br\/?>|&(?:amp|gt|lt|nbsp|quot|#\d+);|[^<&])*$/u;

type Monaco = typeof MonacoModule.monaco;

/**
 * Maps a fence info string onto a registered Monaco language.
 *
 * Monaco is the single source of truth for what `ts`, `typescript`, and `.ts` all mean, so the fence word is matched
 * against each registration's id, aliases, and extensions rather than against a second hand-written table that would
 * drift from the editor's own highlighting.
 */
function monacoLanguageId(monaco: Monaco, fence: string): string | undefined {
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

/**
 * The display name Monaco registers for a fence word (`ts` reads as `TypeScript`), for a code block's header. Comes
 * from the same registration that paints the block, so the label and the colors always agree.
 */
export async function codeLanguageName(fence: string): Promise<string | undefined> {
    const { monaco } = await import('./monaco');
    const languageId = monacoLanguageId(monaco, fence);
    if (!languageId) return undefined;
    return monaco.languages.getLanguages().find((language) => language.id === languageId)
        ?.aliases?.[0];
}

/**
 * Paints `code` with the editor's own token colors, so a fenced block in a Markdown preview or a Chat reply and the
 * same lines in the editor share one set of colors and no second highlighting library has to track the theme.
 *
 * Monaco is imported on demand: a Chat that never shows a code block never loads it. The active Caxri theme is applied
 * first because a window with no editor open has never defined it. Resolves to `undefined` for a language Monaco does
 * not know, which callers render as plain text.
 */
export async function colorizeCode(
    code: string,
    fence: string,
    theme: ThemeTokens | undefined,
): Promise<string | undefined> {
    const [{ monaco }, { appliedEditorThemeKey, applyEditorTheme }] = await Promise.all([
        import('./monaco'),
        import('./editor-theme'),
    ]);
    if (theme) applyEditorTheme(theme);
    const languageId = monacoLanguageId(monaco, fence);
    if (!languageId) return undefined;
    const key = `${appliedEditorThemeKey() ?? ''}\0${languageId}\0${code}`;
    const cached = colorizedBlocks.get(key);
    if (cached !== undefined) return cached;
    const html = await monaco.editor.colorize(code, languageId, {});
    if (!COLORIZED_MARKUP.test(html)) return undefined;
    colorizedBlocks.set(key, html);
    return html;
}

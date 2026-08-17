import type { ThemeTokens } from '@shared/types';

import { monacoBaseThemeFor } from './editor-theme-base';
import { monaco } from './monaco';

/**
 * Keeps every Monaco surface aligned with the active Caxri theme.
 *
 * Token `foreground` values omit `#` and may still carry an 8-digit alpha suffix. Monaco's ColorMap
 * (`/^#?([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/`) accepts that form and keeps only the RGB group, so markup tokens do not
 * need the `.slice(0, 7)` strip that `diffEditor.*Background` uses when it concatenates a new CSS alpha onto a
 * `#RRGGBB` color.
 */
export function applyEditorTheme(theme: ThemeTokens): void {
    monaco.editor.defineTheme('caxri-active', {
        base: monacoBaseThemeFor(theme.editor.background),
        inherit: true,
        rules: [
            { token: 'comment', foreground: theme.editor.comment.slice(1) },
            { token: 'keyword', foreground: theme.editor.keyword.slice(1) },
            { token: 'string', foreground: theme.editor.string.slice(1) },
            { token: 'number', foreground: theme.editor.number.slice(1) },
            { token: 'variable.env', foreground: theme.terminal.cyan.slice(1) },
            { token: 'delimiter.env', foreground: theme.editor.keyword.slice(1) },
            { token: 'string.key.json', foreground: theme.terminal.cyan.slice(1) },
            { token: 'string.value.json', foreground: theme.editor.string.slice(1) },
            { token: 'keyword.json', foreground: theme.editor.keyword.slice(1) },
            { token: 'number.json', foreground: theme.editor.number.slice(1) },
            { token: 'delimiter.bracket.json', foreground: theme.editor.keyword.slice(1) },
            { token: 'delimiter.array.json', foreground: theme.editor.keyword.slice(1) },
            { token: 'delimiter.colon.json', foreground: theme.editor.keyword.slice(1) },
            { token: 'delimiter.comma.json', foreground: theme.editor.keyword.slice(1) },
            { token: 'meta.diff', foreground: theme.colors.muted.slice(1) },
            { token: 'keyword.diff', foreground: theme.terminal.cyan.slice(1) },
            { token: 'markup.inserted', foreground: theme.colors.success.slice(1) },
            { token: 'markup.deleted', foreground: theme.colors.danger.slice(1) },
        ],
        colors: {
            'editor.background': theme.editor.background,
            'editor.foreground': theme.editor.foreground,
            'editor.lineHighlightBackground': theme.editor.lineHighlight,
            'editor.selectionBackground': theme.editor.selection,
            'diffEditor.insertedTextBackground': `${theme.colors.success.slice(0, 7)}20`,
            'diffEditor.removedTextBackground': `${theme.colors.danger.slice(0, 7)}50`,
            'editorGutter.addedBackground': theme.colors.success,
            'editorGutter.deletedBackground': theme.colors.danger,
        },
    });
    monaco.editor.setTheme('caxri-active');
}
